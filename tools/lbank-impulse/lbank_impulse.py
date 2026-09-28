from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import tkinter as tk
from tkinter import messagebox, ttk


ROOT = Path(__file__).resolve().parents[2]
SIDECAR = Path(__file__).with_name("sidecar.cjs")
SPACE_XXS, SPACE_XS, SPACE_SM, SPACE_MD, SPACE_LG = 2, 4, 8, 12, 18

COLORS = {
    "bg": "#07090c",
    "panel": "#0d1014",
    "panel_alt": "#12161c",
    "panel_soft": "#10141a",
    "border": "#20262e",
    "border_focus": "#354039",
    "text": "#f2f5f7",
    "muted": "#7e8996",
    "green": "#38c977",
    "green_soft": "#183728",
    "red": "#ff626c",
    "red_soft": "#3b1d22",
    "amber": "#d9a84e",
    "input": "#090c10",
}

STRATEGY_FIELDS = [
    ("nominal", "Номинал позиции, USDT", "50"),
    ("leverage", "Плечо", "5"),
    ("impulsePercent", "Импульс, %", "0.04"),
    ("cooldownSeconds", "Cooldown, сек", "180"),
    ("impulseWindowMs", "Окно импульса, мс", "1000"),
    ("entryLifetimeMs", "Жизнь лимитки, мс", "5000"),
    ("minimumHoldMs", "Минимальное удержание, мс", "2000"),
    ("trailingActivationPercent", "Сильный лаг: продолжаем держать, %", "0.03"),
    ("reversalPercent", "Трейлинг-откат от лучшей цены, %", "0.02"),
    ("reversalHoldMs", "Подтверждение отката, мс", "0"),
    ("adversePercent", "Мягкий стоп (hard ×3), %", "0.03"),
    ("maxHoldSeconds", "Предохранитель удержания, сек", "60"),
    ("minimumTrailNetPercent", "Минимальный net для трейлинга, %", "0"),
    ("maxEntrySlippagePercent", "Допуск цены LIMIT-входа, %", "0"),
    ("depthSafetyMultiplier", "Запас видимой глубины, × объём", "2"),
    ("maxLossPercent", "Макс. риск AUTO, % баланса", "1"),
    ("basisHalfLifeSeconds", "Half-life базиса, сек", "30"),
]
INTEGER_SETTINGS = {"leverage", "cooldownSeconds", "impulseWindowMs", "entryLifetimeMs", "minimumHoldMs", "reversalHoldMs", "maxHoldSeconds", "basisHalfLifeSeconds"}


def number(value: Any) -> float | None:
    try:
        result = float(value)
        return result if result == result and abs(result) != float("inf") else None
    except (TypeError, ValueError):
        return None


def fmt_price(value: Any) -> str:
    value = number(value)
    if value is None:
        return "n/a"
    if abs(value) >= 1000:
        return f"{value:,.2f}".replace(",", " ")
    if abs(value) >= 1:
        return f"{value:.5f}".rstrip("0").rstrip(".")
    return f"{value:.10f}".rstrip("0").rstrip(".")


def fmt_money(value: Any) -> str:
    value = number(value)
    if value is None:
        return "n/a"
    sign = "−" if value < 0 else ""
    return f"{sign}${abs(value):,.2f}".replace(",", " ")


def fmt_bps(value: Any) -> str:
    value = number(value)
    return "n/a" if value is None else f"{value:+.2f} bps"


def phase_text(value: str) -> str:
    return {
        "disconnected": "Нет подключения",
        "connecting": "Подключение",
        "connected": "Профиль подключён",
        "configuring": "Проверка параметров",
        "ready": "Готов к запуску",
        "warming_up": "Ожидание первых котировок",
        "waiting": "Ожидание импульса",
        "submitting": "Отправка входа",
        "order": "Лимитка активна",
        "canceling": "Отмена лимитки",
        "protecting": "Установка TP/SL",
        "position": "Позиция под контролем",
        "closing": "Закрытие позиции",
        "cooldown": "Cooldown",
        "paused": "Пауза",
        "flattening": "STOP & FLAT",
        "recovery": "Требуется сверка",
        "entry_unknown": "Неизвестен результат входа",
        "error": "Требуется внимание",
    }.get(str(value), str(value or "n/a"))


def decision_text(reason: Any, eligible: bool = False) -> str:
    if eligible:
        return "ВХОД РАЗРЕШЁН"
    return {
        "warming_up": "Ожидание первых котировок",
        "no_impulse": "Импульс ниже порога",
        "lag_not_positive": "Нет лага в сторону сигнала",
        "edge_too_small": "Edge не покрывает расходы",
        "insufficient_exit_depth": "Мало глубины для выхода",
        "leader_stale": "Ведущая котировка устарела",
        "lbank_stale": "Стакан LBank устарел",
        "invalid_book_or_size": "Стакан или размер некорректен",
    }.get(str(reason or ""), "Ожидание данных")


def exit_reason_text(reason: Any) -> str:
    return {
        "reversal": "трейлинг: подтверждённый откат",
        "hard_stop": "аварийный стоп",
        "max_hold": "истекло максимальное удержание",
        "stale_market_data": "потеря свежих котировок",
        "manual_flatten": "STOP & FLAT",
        "shutdown": "закрытие приложения",
        "protection_failed": "защита не подтверждена",
    }.get(str(reason or ""), str(reason or "n/a"))


@dataclass
class PendingRequest:
    command: str
    callback: Callable[[dict[str, Any]], None]
    started_at: float


class SidecarClient:
    def __init__(self, on_message: Callable[[dict[str, Any]], None]):
        self.on_message = on_message
        self.inbox: queue.Queue[dict[str, Any]] = queue.Queue()
        self.pending: dict[str, PendingRequest] = {}
        self.write_lock = threading.Lock()
        self.process: subprocess.Popen[str] | None = None
        self._start()

    def _start(self) -> None:
        node = shutil.which("node")
        if not node:
            raise RuntimeError("Node.js не найден в PATH")
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        self.process = subprocess.Popen(
            [node, str(SIDECAR)], cwd=str(ROOT), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=flags,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def _read_stdout(self) -> None:
        assert self.process and self.process.stdout
        for line in self.process.stdout:
            try:
                self.inbox.put(json.loads(line))
            except json.JSONDecodeError:
                self.inbox.put({"type": "error", "error": {"message": "Sidecar вернул некорректный JSON"}})
        self.inbox.put({"type": "process_exit", "code": self.process.poll()})

    def _read_stderr(self) -> None:
        assert self.process and self.process.stderr
        for line in self.process.stderr:
            text = line.strip()
            if text:
                self.inbox.put({"type": "diagnostic", "message": text[:500]})

    def request(self, command: str, params: dict[str, Any] | None, callback: Callable[[dict[str, Any]], None]) -> str:
        if not self.process or self.process.poll() is not None or not self.process.stdin:
            callback({"ok": False, "error": {"message": "Sidecar не запущен"}})
            return ""
        request_id = uuid.uuid4().hex
        payload = {"v": 1, "requestId": request_id, "command": command, "params": params or {}}
        self.pending[request_id] = PendingRequest(command, callback, time.monotonic())
        try:
            with self.write_lock:
                self.process.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                self.process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            self.pending.pop(request_id, None)
            callback({"ok": False, "error": {"message": f"Sidecar отключён: {error}"}})
        return request_id

    def poll(self) -> None:
        while True:
            try:
                message = self.inbox.get_nowait()
            except queue.Empty:
                break
            if message.get("type") == "response":
                pending = self.pending.pop(str(message.get("requestId") or ""), None)
                if pending:
                    pending.callback(message)
            else:
                self.on_message(message)
        now = time.monotonic()
        expired = [request_id for request_id, pending in self.pending.items() if now - pending.started_at > 90]
        for request_id in expired:
            pending = self.pending.pop(request_id)
            pending.callback({"ok": False, "error": {"message": f"Команда {pending.command} не завершилась за 90 секунд"}})

    def terminate(self) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()


class VenuePanel(ttk.Frame):
    def __init__(self, parent: tk.Misc, venue: str, book_rows: int = 8):
        super().__init__(parent, style="Panel.TFrame", padding=SPACE_MD)
        self.venue = venue
        self.columnconfigure(0, weight=1)
        header = ttk.Frame(self, style="Panel.TFrame")
        header.grid(row=0, column=0, sticky="ew", pady=(0, SPACE_SM))
        header.columnconfigure(0, weight=1)
        self.title = ttk.Label(header, text=venue.upper(), style="PanelTitle.TLabel")
        self.title.grid(row=0, column=0, sticky="w")
        self.age = ttk.Label(header, text="нет данных", style="Muted.TLabel")
        self.age.grid(row=0, column=1, sticky="e")

        metrics = ttk.Frame(self, style="Panel.TFrame")
        metrics.grid(row=1, column=0, sticky="ew", pady=(0, SPACE_SM))
        for column in range(3):
            metrics.columnconfigure(column, weight=1)
        self.bid = self._metric(metrics, "BID", 0, COLORS["green"])
        self.ask = self._metric(metrics, "ASK", 1, COLORS["red"])
        self.spread = self._metric(metrics, "SPREAD", 2, COLORS["text"])

        self.depth = ttk.Label(self, text="Глубина: n/a", style="Muted.TLabel")
        self.depth.grid(row=2, column=0, sticky="w", pady=(0, SPACE_SM))
        self.book = tk.Text(
            self, height=max(5, book_rows * 2 + 2), bg=COLORS["input"], fg=COLORS["text"], relief="flat", borderwidth=0,
            font=("Cascadia Mono", 9), padx=SPACE_SM, pady=SPACE_SM, state="disabled", wrap="none",
        )
        self.book.tag_configure("ask", foreground=COLORS["red"])
        self.book.tag_configure("bid", foreground=COLORS["green"])
        self.book.tag_configure("head", foreground=COLORS["muted"])
        self.book.grid(row=3, column=0, sticky="nsew")
        self.rowconfigure(3, weight=1)

    def _metric(self, parent: ttk.Frame, label: str, column: int, color: str) -> ttk.Label:
        cell = ttk.Frame(parent, style="Panel.TFrame")
        cell.grid(row=0, column=column, sticky="ew", padx=(0 if column == 0 else SPACE_SM, 0))
        ttk.Label(cell, text=label, style="MetricName.TLabel").pack(anchor="w")
        value = ttk.Label(cell, text="n/a", style="Metric.TLabel", foreground=color)
        value.pack(anchor="w")
        return value

    def update_data(self, data: dict[str, Any] | None, elapsed_ms: int = 0) -> None:
        if not data:
            self.age.configure(text="нет данных")
            self.bid.configure(text="n/a"); self.ask.configure(text="n/a"); self.spread.configure(text="n/a")
            self.depth.configure(text="Глубина: n/a")
            self._set_book([], [])
            return
        age = max(0, int(number(data.get("ageMs")) or 0) + elapsed_ms)
        self.age.configure(text=f"{age} ms", foreground=COLORS["green"] if age <= (1000 if self.venue == "lbank" else 500) else COLORS["red"])
        self.bid.configure(text=fmt_price(data.get("bid"))); self.ask.configure(text=fmt_price(data.get("ask")))
        spread = number(data.get("spreadBps")); self.spread.configure(text="n/a" if spread is None else f"{spread:.2f} bps")
        self.depth.configure(text=f"Глубина номинала: bid {fmt_money(data.get('bidDepthUsd'))} · ask {fmt_money(data.get('askDepthUsd'))}")
        self._set_book(data.get("bids") or [], data.get("asks") or [])

    def _set_book(self, bids: list[dict[str, Any]], asks: list[dict[str, Any]]) -> None:
        self.book.configure(state="normal"); self.book.delete("1.0", "end")
        self.book.insert("end", f"{'SIDE':<5} {'PRICE':>16} {'QTY':>14}\n", "head")
        visible = max(2, (int(self.book.cget("height")) - 2) // 2)
        for row in reversed(asks[:visible]):
            self.book.insert("end", f"{'ASK':<5} {fmt_price(row.get('price')):>16} {fmt_price(row.get('quantity')):>14}\n", "ask")
        self.book.insert("end", "─" * 39 + "\n", "head")
        for row in bids[:visible]:
            self.book.insert("end", f"{'BID':<5} {fmt_price(row.get('price')):>16} {fmt_price(row.get('quantity')):>14}\n", "bid")
        self.book.configure(state="disabled")


class LBankImpulseApp:
    def __init__(self, root: tk.Tk, smoke: bool = False, client_factory: Callable[[Callable[[dict[str, Any]], None]], Any] = SidecarClient,
                 persist_logs: bool = True, log_path: Path | None = None, auto_live: bool = False, live_symbol: str | None = None):
        self.root = root; self.smoke = smoke; self.closing = False; self.alarm = False; self.action_pending = False; self.start_token = 0
        self.auto_live_requested = auto_live; self.live_symbol = str(live_symbol or '').upper().replace('_', '').replace('-', '') or None
        self.auto_live_connecting = False; self.auto_live_started = False
        self.poll_job: str | None = None; self.age_job: str | None = None; self.alarm_job: str | None = None; self.save_job: str | None = None
        self.profile_map: dict[str, str] = {}; self.state: dict[str, Any] = {}; self.market: dict[str, Any] = {}; self.market_received = 0.0
        self.last_log: tuple[str, float] | None = None; self.symbols: list[str] = []; self.current_pnl: float | None = None
        self.analyzer: dict[str, Any] = {}; self.portfolio: dict[str, Any] = {}; self.analyzer_rows: list[dict[str, Any]] = []
        self.log_follow_tail = True
        app_data = Path(os.environ.get("APPDATA") or ROOT / "output")
        self.log_path = (log_path or app_data / "Hedge LBank" / "impulse" / "logs" / "ui.log") if persist_logs and not smoke else None
        self.log_io_lock = threading.Lock()
        self.profile_var = tk.StringVar(); self.symbol_var = tk.StringVar(value="BTCUSDT"); self.mode_var = tk.StringVar(value="Paper"); self.settings_mode_var = tk.StringVar(value="Paper")
        self.analyzer_search_var = tk.StringVar(); self.analyzer_filter_var = tk.StringVar(value="Все монеты")
        self.setting_vars = {key: tk.StringVar(value=default) for key, _label, default in STRATEGY_FIELDS}
        self.override_vars = {key: tk.BooleanVar(value=False) for key, _label, _default in STRATEGY_FIELDS}
        self.settings_scope_var = tk.StringVar(value="global")
        self.settings_window: tk.Toplevel | None = None; self.settings_entries: dict[str, ttk.Entry] = {}; self.settings_checks: dict[str, ttk.Checkbutton] = {}
        self.settings_status: ttk.Label | None = None; self.settings_save_button: ttk.Button | None = None; self.settings_reset_button: ttk.Button | None = None
        self.form_ready = False; self.form_dirty = False; self.applying_settings = False; self.draft_revision = 0; self.variable_traces: list[tuple[tk.StringVar, str]] = []
        self._style(); self._build(); self._load_saved_logs()
        self.client = client_factory(self._on_message)
        self.poll_job = self.root.after(40, self._poll)
        self.age_job = self.root.after(250, self._refresh_ages)
        self.root.protocol("WM_DELETE_WINDOW", self._close)
        if smoke:
            self.root.after(250, self._load_smoke_data)
            self.root.after(12000, self._close)

    def _style(self) -> None:
        self.root.title("LBank Impulse · Smoke" if self.smoke else "LBank Impulse · Local")
        self.root.configure(bg=COLORS["bg"])
        self.root.geometry("1600x940")
        self.root.minsize(1180, 760)
        style = ttk.Style(self.root); style.theme_use("clam")
        style.configure(".", background=COLORS["bg"], foreground=COLORS["text"], font=("Segoe UI Variable", 10))
        style.configure("TFrame", background=COLORS["bg"])
        style.configure("Panel.TFrame", background=COLORS["panel"], relief="flat")
        style.configure("Soft.TFrame", background=COLORS["panel_soft"], relief="flat")
        style.configure("TLabel", background=COLORS["bg"], foreground=COLORS["text"])
        style.configure("Panel.TLabel", background=COLORS["panel"], foreground=COLORS["text"])
        style.configure("Soft.TLabel", background=COLORS["panel_soft"], foreground=COLORS["text"])
        style.configure("Muted.TLabel", background=COLORS["panel"], foreground=COLORS["muted"], font=("Segoe UI Variable", 9))
        style.configure("SoftMuted.TLabel", background=COLORS["panel_soft"], foreground=COLORS["muted"], font=("Segoe UI Variable", 9))
        style.configure("Title.TLabel", background=COLORS["bg"], foreground=COLORS["text"], font=("Segoe UI Variable Display Semibold", 22))
        style.configure("Subtitle.TLabel", background=COLORS["bg"], foreground=COLORS["muted"], font=("Segoe UI Variable", 10))
        style.configure("PanelTitle.TLabel", background=COLORS["panel"], foreground=COLORS["text"], font=("Segoe UI Variable Semibold", 11))
        style.configure("SoftTitle.TLabel", background=COLORS["panel_soft"], foreground=COLORS["text"], font=("Segoe UI Variable Semibold", 11))
        style.configure("MetricName.TLabel", background=COLORS["panel"], foreground=COLORS["muted"], font=("Segoe UI Variable", 8))
        style.configure("Metric.TLabel", background=COLORS["panel"], foreground=COLORS["text"], font=("Cascadia Mono", 12, "bold"))
        style.configure("HeroMetric.TLabel", background=COLORS["panel"], foreground=COLORS["text"], font=("Cascadia Mono", 17, "bold"))
        style.configure("TEntry", fieldbackground=COLORS["input"], foreground=COLORS["text"], insertcolor=COLORS["text"], bordercolor=COLORS["border"], lightcolor=COLORS["border"], darkcolor=COLORS["border"], padding=8)
        style.configure("TCombobox", fieldbackground=COLORS["input"], foreground=COLORS["text"], arrowcolor=COLORS["muted"], bordercolor=COLORS["border"], lightcolor=COLORS["border"], darkcolor=COLORS["border"], padding=7)
        style.map("TCombobox", fieldbackground=[("readonly", COLORS["input"])], foreground=[("readonly", COLORS["text"])])
        style.configure("TButton", background=COLORS["panel_alt"], foreground=COLORS["text"], bordercolor=COLORS["border"], lightcolor=COLORS["border"], darkcolor=COLORS["border"], padding=(12, 8), font=("Segoe UI Variable Semibold", 9))
        style.map("TButton", background=[("active", COLORS["border"]), ("disabled", COLORS["panel"])] )
        style.configure("Primary.TButton", background=COLORS["green"], foreground="#06150d", bordercolor=COLORS["green"], font=("Segoe UI Variable Semibold", 10), padding=(14, 9))
        style.map("Primary.TButton", background=[("active", "#58dc91")])
        style.configure("Danger.TButton", background=COLORS["red"], foreground="#170407", bordercolor=COLORS["red"], font=("Segoe UI Variable Semibold", 10), padding=(14, 9))
        style.map("Danger.TButton", background=[("active", "#ff7a84")])
        style.configure("Treeview", background=COLORS["input"], fieldbackground=COLORS["input"], foreground=COLORS["text"], bordercolor=COLORS["border"], lightcolor=COLORS["border"], darkcolor=COLORS["border"], rowheight=30, font=("Cascadia Mono", 9))
        style.configure("Treeview.Heading", background=COLORS["panel_alt"], foreground=COLORS["muted"], relief="flat", bordercolor=COLORS["border"], font=("Segoe UI Variable Semibold", 9), padding=(8, 7))
        style.map("Treeview", background=[("selected", COLORS["green_soft"])], foreground=[("selected", COLORS["text"])])
        style.map("Treeview.Heading", background=[("active", COLORS["panel_alt"])])
        style.configure("TNotebook", background=COLORS["panel"], borderwidth=0)
        style.configure("TNotebook.Tab", background=COLORS["panel"], foreground=COLORS["muted"], borderwidth=0, padding=(12, 7), font=("Segoe UI Variable Semibold", 9))
        style.map("TNotebook.Tab", background=[("selected", COLORS["panel_alt"])], foreground=[("selected", COLORS["text"])])

    def _build(self) -> None:
        container = self.container = ttk.Frame(self.root, padding=(SPACE_LG, SPACE_MD))
        container.pack(fill="both", expand=True); container.columnconfigure(0, weight=1); container.rowconfigure(1, weight=1)

        header = ttk.Frame(container); header.grid(row=0, column=0, sticky="ew", pady=(0, SPACE_MD)); header.columnconfigure(0, weight=1)
        ttk.Label(header, text="LBank Impulse", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(header, text="Portfolio execution and adaptive market research", style="Subtitle.TLabel").grid(row=1, column=0, sticky="w", pady=(SPACE_XS, 0))
        self.analyzer_badge = ttk.Label(header, text="АНАЛИЗАТОР: ЗАПУСК", background=COLORS["panel_alt"], foreground=COLORS["muted"], padding=(12, 6), font=("Segoe UI Variable Semibold", 9))
        self.analyzer_badge.grid(row=0, column=1, rowspan=2, sticky="e", padx=(0, SPACE_SM))
        self.settings_button = ttk.Button(header, text="Настройки", command=self._open_settings)
        self.settings_button.grid(row=0, column=2, rowspan=2, sticky="e", padx=(0, SPACE_SM))
        self.mode_badge = ttk.Label(header, text="PAPER", background=COLORS["amber"], foreground="#1b1202", padding=(12, 6), font=("Segoe UI Variable Semibold", 10))
        self.mode_badge.grid(row=0, column=3, rowspan=2, sticky="e")

        workspace = self.lower_panel = ttk.Frame(container); workspace.grid(row=1, column=0, sticky="nsew", pady=(0, SPACE_MD))
        workspace.columnconfigure(0, weight=38); workspace.columnconfigure(1, weight=62); workspace.rowconfigure(0, weight=1)
        left = self.info_panel = ttk.Frame(workspace); left.grid(row=0, column=0, sticky="nsew", padx=(0, SPACE_SM)); left.columnconfigure(0, weight=1); left.rowconfigure(3, weight=1)
        right = self.analyzer_panel = ttk.Frame(workspace, style="Panel.TFrame", padding=SPACE_MD); right.grid(row=0, column=1, sticky="nsew", padx=(SPACE_SM, 0)); right.columnconfigure(0, weight=1); right.rowconfigure(3, weight=1)

        setup = self.setup_panel = ttk.Frame(left, style="Panel.TFrame", padding=SPACE_MD); setup.grid(row=0, column=0, sticky="ew", pady=(0, SPACE_SM))
        setup.columnconfigure(0, weight=3); setup.columnconfigure(1, weight=2)
        ttk.Label(setup, text="ТОРГОВЫЙ ПРОФИЛЬ", style="Muted.TLabel").grid(row=0, column=0, sticky="w")
        self.symbol_label = ttk.Label(setup, text="Монета", style="Muted.TLabel"); self.symbol_label.grid(row=0, column=1, sticky="w", padx=(SPACE_MD, 0))
        self.profile_combo = ttk.Combobox(setup, textvariable=self.profile_var, state="readonly")
        self.profile_combo.grid(row=1, column=0, sticky="ew", pady=(SPACE_XS, 0))
        self.symbol_combo = ttk.Combobox(setup, textvariable=self.symbol_var, state="normal")
        self.symbol_combo.grid(row=1, column=1, sticky="ew", padx=(SPACE_MD, 0), pady=(SPACE_XS, 0))
        self.symbol_combo.bind("<KeyRelease>", self._filter_symbols); self.symbol_combo.bind("<<ComboboxSelected>>", self._symbol_selected)
        self.refresh_profiles_button = ttk.Button(setup, text="Обновить", command=self._profiles)
        self.refresh_profiles_button.grid(row=1, column=2, padx=(SPACE_SM, 0), pady=(SPACE_XS, 0))
        self.connect_button = ttk.Button(setup, text="Подключить LBank", command=self._connect)
        self.connect_button.grid(row=1, column=3, padx=(SPACE_SM, 0), pady=(SPACE_XS, 0))
        self.settings_summary = ttk.Label(setup, text="Загрузка...", style="Muted.TLabel", font=("Cascadia Mono", 8), wraplength=520)
        self.settings_summary.grid(row=2, column=0, columnspan=4, sticky="w", pady=(SPACE_SM, 0))

        status = self.status_panel = ttk.Frame(left, style="Panel.TFrame", padding=SPACE_MD); status.grid(row=1, column=0, sticky="ew", pady=(0, SPACE_SM)); status.columnconfigure(1, weight=1)
        self.phase_dot = tk.Canvas(status, width=12, height=12, bg=COLORS["panel"], highlightthickness=0)
        self.phase_dot.grid(row=0, column=0, rowspan=2, padx=(0, SPACE_SM)); self.dot_id = self.phase_dot.create_oval(1, 1, 11, 11, fill=COLORS["muted"], outline="")
        self.phase_label = ttk.Label(status, text="Запуск ядра...", style="PanelTitle.TLabel"); self.phase_label.grid(row=0, column=1, sticky="w")
        self.detail_label = ttk.Label(status, text="Ожидаем локальное ядро", style="Muted.TLabel", wraplength=470); self.detail_label.grid(row=1, column=1, sticky="w", pady=(SPACE_XS, 0))
        self.portfolio_status = ttk.Label(status, text="AUTO LIVE: PAUSED", style="Muted.TLabel"); self.portfolio_status.grid(row=2, column=1, sticky="w", pady=(SPACE_SM, 0))
        actions = self.actions = ttk.Frame(status, style="Panel.TFrame"); actions.grid(row=3, column=0, columnspan=2, sticky="ew", pady=(SPACE_MD, 0))
        for column in range(4): actions.columnconfigure(column, weight=1)
        self.auto_start_button = ttk.Button(actions, text="START AUTO", style="Primary.TButton", command=self._portfolio_start)
        self.auto_start_button.grid(row=0, column=0, sticky="ew", padx=(0, SPACE_XS))
        self.start_button = ttk.Button(actions, text="1 COIN", command=self._start); self.start_button.grid(row=0, column=1, sticky="ew", padx=SPACE_XS)
        self.pause_button = ttk.Button(actions, text="PAUSE", command=self._pause); self.pause_button.grid(row=0, column=2, sticky="ew", padx=SPACE_XS)
        self.flatten_button = ttk.Button(actions, text="STOP & FLAT", style="Danger.TButton", command=self._flatten); self.flatten_button.grid(row=0, column=3, sticky="ew", padx=(SPACE_XS, 0))

        signal = ttk.Frame(left, style="Panel.TFrame", padding=SPACE_MD); signal.grid(row=2, column=0, sticky="ew", pady=(0, SPACE_SM)); signal.columnconfigure(1, weight=1); signal.columnconfigure(3, weight=1)
        ttk.Label(signal, text="Исполнение", style="PanelTitle.TLabel").grid(row=0, column=0, columnspan=4, sticky="w", pady=(0, SPACE_SM))
        self.signal_values: dict[str, ttk.Label] = {}
        rows = [("Направление", "direction"), ("Импульс / порог", "impulse"), ("Лаг / net", "edge"), ("Маршрут / глубина", "execution"),
                ("Решение", "decision"), ("Ордер", "order"), ("Позиция", "position"), ("Контроль", "hold"), ("PnL сейчас", "pnl"),
                ("Сделки W/L/0", "trades"), ("Gross / fees / net", "session"), ("Базис", "basis")]
        split = (len(rows) + 1) // 2
        for index, (title, key) in enumerate(rows):
            group = 0 if index < split else 2; row = index + 1 if index < split else index - split + 1
            ttk.Label(signal, text=title, style="Muted.TLabel").grid(row=row, column=group, sticky="w", pady=SPACE_XXS, padx=(SPACE_MD if group else 0, 0))
            value = ttk.Label(signal, text="n/a", style="Panel.TLabel", font=("Cascadia Mono", 8), anchor="e", wraplength=190)
            value.grid(row=row, column=group + 1, sticky="e", padx=(SPACE_SM, 0), pady=SPACE_XXS); self.signal_values[key] = value

        self.venues_panel = ttk.Frame(left, style="Panel.TFrame", padding=(SPACE_XS, SPACE_XS)); self.venues_panel.grid(row=3, column=0, sticky="nsew")
        self.venues_panel.columnconfigure(0, weight=1); self.venues_panel.rowconfigure(0, weight=1)
        self.venue_tabs = ttk.Notebook(self.venues_panel); self.venue_tabs.grid(row=0, column=0, sticky="nsew")
        self.venues = {venue: VenuePanel(self.venue_tabs, venue, book_rows=5) for venue in ["lbank", "binance", "mexc"]}
        for venue in ["lbank", "binance", "mexc"]: self.venue_tabs.add(self.venues[venue], text=venue.upper())

        analyzer_head = ttk.Frame(right, style="Panel.TFrame"); analyzer_head.grid(row=0, column=0, sticky="ew", pady=(0, SPACE_MD)); analyzer_head.columnconfigure(0, weight=1)
        ttk.Label(analyzer_head, text="Анализатор рынка", style="PanelTitle.TLabel", font=("Segoe UI Variable Display Semibold", 15)).grid(row=0, column=0, sticky="w")
        self.analyzer_detail = ttk.Label(analyzer_head, text="Публичные потоки запускаются автоматически", style="Muted.TLabel"); self.analyzer_detail.grid(row=1, column=0, sticky="w", pady=(SPACE_XS, 0))
        self.analyzer_toggle_button = ttk.Button(analyzer_head, text="Пауза анализа", command=self._toggle_analyzer); self.analyzer_toggle_button.grid(row=0, column=1, rowspan=2, sticky="e")

        summary = ttk.Frame(right, style="Soft.TFrame", padding=SPACE_MD); summary.grid(row=1, column=0, sticky="ew", pady=(0, SPACE_MD))
        for column in range(4): summary.columnconfigure(column, weight=1, uniform="analyzer_metrics")
        self.analyzer_metrics: dict[str, ttk.Label] = {}
        for column, (title, key) in enumerate([("МОНЕТ", "symbols"), ("СДЕЛОК", "trades"), ("NET PAPER", "net"), ("ГОТОВЫ LIVE", "ready")]):
            cell = ttk.Frame(summary, style="Soft.TFrame"); cell.grid(row=0, column=column, sticky="ew", padx=(0 if column == 0 else SPACE_MD, 0))
            ttk.Label(cell, text=title, style="SoftMuted.TLabel").pack(anchor="w")
            value = ttk.Label(cell, text="0", style="Soft.TLabel", font=("Cascadia Mono", 15, "bold")); value.pack(anchor="w", pady=(SPACE_XS, 0)); self.analyzer_metrics[key] = value

        toolbar = ttk.Frame(right, style="Panel.TFrame"); toolbar.grid(row=2, column=0, sticky="ew", pady=(0, SPACE_SM)); toolbar.columnconfigure(0, weight=1)
        self.analyzer_search = ttk.Entry(toolbar, textvariable=self.analyzer_search_var); self.analyzer_search.grid(row=0, column=0, sticky="ew")
        self.analyzer_search_var.trace_add("write", lambda *_args: self._render_analyzer_rows())
        self.analyzer_filter = ttk.Combobox(toolbar, textvariable=self.analyzer_filter_var, values=["Все монеты", "Готовы Live", "Есть сделки", "Заблокированы"], state="readonly", width=18)
        self.analyzer_filter.grid(row=0, column=1, padx=(SPACE_SM, 0)); self.analyzer_filter.bind("<<ComboboxSelected>>", lambda _event: self._render_analyzer_rows())

        table_frame = ttk.Frame(right, style="Panel.TFrame"); table_frame.grid(row=3, column=0, sticky="nsew"); table_frame.columnconfigure(0, weight=1); table_frame.rowconfigure(0, weight=1)
        columns = ("rank", "symbol", "leader", "threshold", "trades", "wr", "net", "fill", "lag", "status")
        self.analyzer_tree = ttk.Treeview(table_frame, columns=columns, show="headings", selectmode="browse")
        headings = {"rank": "#", "symbol": "SYMBOL", "leader": "LEADER", "threshold": "MOVE", "trades": "TRADES", "wr": "WIN", "net": "NET", "fill": "FILL", "lag": "LAG", "status": "STATE"}
        widths = {"rank": 38, "symbol": 100, "leader": 72, "threshold": 64, "trades": 60, "wr": 62, "net": 82, "fill": 62, "lag": 70, "status": 112}
        for key in columns:
            self.analyzer_tree.heading(key, text=headings[key]); self.analyzer_tree.column(key, width=widths[key], minwidth=widths[key], anchor="w" if key in {"symbol", "status"} else "center", stretch=key in {"symbol", "status"})
        self.analyzer_tree.tag_configure("positive", foreground=COLORS["green"]); self.analyzer_tree.tag_configure("negative", foreground=COLORS["red"])
        self.analyzer_tree.tag_configure("blocked", foreground=COLORS["muted"]); self.analyzer_tree.grid(row=0, column=0, sticky="nsew")
        self.analyzer_tree.bind("<<TreeviewSelect>>", self._show_analyzer_detail)
        self.analyzer_tree.bind("<Double-1>", self._select_analyzer_symbol)
        analyzer_scroll = ttk.Scrollbar(table_frame, orient="vertical", command=self.analyzer_tree.yview); analyzer_scroll.grid(row=0, column=1, sticky="ns", padx=(SPACE_XS, 0)); self.analyzer_tree.configure(yscrollcommand=analyzer_scroll.set)
        self.candidate_detail = ttk.Label(right, text="Кандидаты появятся после реальных Paper-наблюдений", style="Muted.TLabel", wraplength=850)
        self.candidate_detail.grid(row=4, column=0, sticky="ew", pady=(SPACE_SM, 0))

        log_panel = self.log_panel = ttk.Frame(container, style="Panel.TFrame", padding=SPACE_MD); log_panel.grid(row=2, column=0, sticky="nsew"); log_panel.columnconfigure(0, weight=1); log_panel.rowconfigure(1, weight=1)
        ttk.Label(log_panel, text="Журнал · сохраняется локально", style="PanelTitle.TLabel").grid(row=0, column=0, sticky="w", pady=(0, SPACE_SM))
        self.log_copy_button = ttk.Button(log_panel, text="КОПИРОВАТЬ", command=self._copy_logs); self.log_copy_button.grid(row=0, column=1, sticky="e", pady=(0, SPACE_SM))
        self.log_file_button = ttk.Button(log_panel, text="ФАЙЛ", command=self._open_log_file); self.log_file_button.grid(row=0, column=2, sticky="e", padx=(SPACE_XS, 0), pady=(0, SPACE_SM))
        self.log_tail_button = ttk.Button(log_panel, text="AUTO", command=self._jump_logs_to_end); self.log_tail_button.grid(row=0, column=3, sticky="e", padx=(SPACE_XS, 0), pady=(0, SPACE_SM))
        self.log = tk.Text(log_panel, height=7, bg=COLORS["input"], fg=COLORS["muted"], relief="flat", borderwidth=0, font=("Cascadia Mono", 9), padx=SPACE_SM, pady=SPACE_SM, state="disabled", wrap="word", exportselection=True)
        self.log.tag_configure("error", foreground=COLORS["red"]); self.log.tag_configure("ok", foreground=COLORS["green"]); self.log.tag_configure("info", foreground=COLORS["muted"])
        self.log.grid(row=1, column=0, columnspan=4, sticky="nsew"); self.log_scroll = ttk.Scrollbar(log_panel, orient="vertical", command=self.log.yview)
        self.log_scroll.grid(row=1, column=4, sticky="ns", padx=(SPACE_XS, 0)); self.log.configure(yscrollcommand=self._on_log_scroll)
        self.log_menu = tk.Menu(self.log, tearoff=False, bg=COLORS["panel_alt"], fg=COLORS["text"], activebackground=COLORS["border"], activeforeground=COLORS["text"])
        self.log_menu.add_command(label="Копировать выделенное", command=self._copy_log_selection); self.log_menu.add_command(label="Копировать всё", command=self._copy_logs)
        self.log_menu.add_command(label="Выделить всё", command=self._select_all_logs)
        self.log_menu.add_separator(); self.log_menu.add_command(label="Открыть файл журнала", command=self._open_log_file); self.log_menu.add_command(label="К последним логам", command=self._jump_logs_to_end)
        self.log.bind("<Control-c>", self._copy_log_selection); self.log.bind("<Control-C>", self._copy_log_selection)
        self.log.bind("<Control-a>", self._select_all_logs); self.log.bind("<Control-A>", self._select_all_logs); self.log.bind("<Button-3>", self._show_log_menu)

    @staticmethod
    def _setting_text(value: Any, fallback: str = "") -> str:
        numeric = number(value)
        return fallback if numeric is None else f"{numeric:g}"

    def _settings_profile(self) -> dict[str, Any]:
        profile = self.state.get("settingsProfile")
        if isinstance(profile, dict):
            return profile
        effective = self.state.get("settings") or {}
        global_values = {key: effective.get(key, number(default)) for key, _label, default in STRATEGY_FIELDS}
        return {"version": 2, "profileId": effective.get("profileId", ""), "mode": effective.get("mode", "paper"),
                "paperFast": bool(effective.get("paperFast")), "lastSymbol": effective.get("symbol", "BTCUSDT"),
                "global": global_values, "symbols": {}}

    def _effective_for_symbol(self, symbol: str | None = None) -> dict[str, Any]:
        profile = self._settings_profile(); global_values = dict(profile.get("global") or {})
        selected = symbol or self._normalized_symbol(False) or str(profile.get("lastSymbol") or "BTCUSDT")
        override = (profile.get("symbols") or {}).get(selected) or {}
        return {**global_values, **override, "symbol": selected, "mode": profile.get("mode", "paper"),
                "paperFast": bool(profile.get("paperFast")), "profileId": profile.get("profileId", "")}

    def _load_effective_settings(self, symbol: str | None = None) -> None:
        effective = self._effective_for_symbol(symbol)
        self.applying_settings = True
        try:
            for key, _label, default in STRATEGY_FIELDS:
                self.setting_vars[key].set(self._setting_text(effective.get(key), default))
            self.mode_var.set("Live" if effective.get("mode") == "live" else "Paper Test" if effective.get("paperFast") else "Paper")
        finally:
            self.applying_settings = False
        self._update_settings_summary(); self._update_mode_badge()

    def _update_settings_summary(self) -> None:
        effective = self._effective_for_symbol()
        values = {key: self._setting_text(effective.get(key), self.setting_vars[key].get()) for key, _label, _default in STRATEGY_FIELDS}
        self.settings_summary.configure(text=(f"{values['nominal']} USDT · {values['leverage']}x · импульс {values['impulsePercent']}% · "
                                              f"exec AUTO ≤{values['maxEntrySlippagePercent']}% · depth ×{values['depthSafetyMultiplier']} · "
                                              f"риск AUTO ≤{values['maxLossPercent']}% · hold ≥{values['minimumHoldMs']} мс · "
                                              f"trail {values['trailingActivationPercent']}/{values['reversalPercent']}%"))

    def _symbol_selected(self, event: tk.Event[Any] | None = None) -> None:
        self._filter_symbols(event); symbol = self._normalized_symbol(False)
        if symbol:
            self._load_effective_settings(symbol)
            if self.settings_window and self.settings_window.winfo_exists():
                self._load_settings_scope()

    def _open_settings(self) -> None:
        if self.settings_window and self.settings_window.winfo_exists():
            self.settings_window.deiconify(); self.settings_window.lift(); self.settings_window.focus_force(); return
        window = self.settings_window = tk.Toplevel(self.root)
        window.title("Настройки · LBank Impulse"); window.configure(bg=COLORS["bg"]); window.geometry("920x720")
        window.minsize(800, 680); window.transient(self.root); window.protocol("WM_DELETE_WINDOW", self._close_settings_window)
        container = ttk.Frame(window, padding=(SPACE_LG, SPACE_MD)); container.pack(fill="both", expand=True)
        container.columnconfigure(0, weight=1); container.rowconfigure(2, weight=1)
        header = ttk.Frame(container); header.grid(row=0, column=0, sticky="ew", pady=(0, SPACE_MD)); header.columnconfigure(0, weight=1)
        ttk.Label(header, text="Настройки стратегии", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        ttk.Label(header, text="Глобальные значения используются всеми монетами; включённые поля монеты имеют приоритет.", style="Subtitle.TLabel").grid(row=1, column=0, sticky="w", pady=(SPACE_XS, 0))
        chooser = ttk.Frame(container, style="Panel.TFrame", padding=SPACE_MD); chooser.grid(row=1, column=0, sticky="ew", pady=(0, SPACE_MD))
        chooser.columnconfigure(4, weight=1)
        ttk.Label(chooser, text="Область", style="PanelTitle.TLabel").grid(row=0, column=0, sticky="w", padx=(0, SPACE_MD))
        ttk.Radiobutton(chooser, text="Глобальные", variable=self.settings_scope_var, value="global", command=self._load_settings_scope).grid(row=0, column=1, padx=(0, SPACE_SM))
        self.symbol_scope_radio = ttk.Radiobutton(chooser, text="Для текущей монеты", variable=self.settings_scope_var, value="symbol", command=self._load_settings_scope)
        self.symbol_scope_radio.grid(row=0, column=2, padx=(0, SPACE_LG))
        ttk.Label(chooser, text="Режим", style="Muted.TLabel").grid(row=0, column=3, padx=(0, SPACE_SM))
        self.settings_mode_combo = ttk.Combobox(chooser, textvariable=self.settings_mode_var, values=["Paper", "Paper Test", "Live"], state="readonly", width=12)
        self.settings_mode_combo.grid(row=0, column=4, sticky="w")

        panels = ttk.Frame(container); panels.grid(row=2, column=0, sticky="nsew")
        for column in range(3): panels.columnconfigure(column, weight=1, uniform="settings")
        panels.rowconfigure(0, weight=1)
        panel_titles = ["Сигнал", "Исполнение", "Удержание и выход"]
        split = (len(STRATEGY_FIELDS) + 2) // 3
        for panel_index in range(3):
            panel = ttk.Frame(panels, style="Panel.TFrame", padding=SPACE_MD)
            panel.grid(row=0, column=panel_index, sticky="nsew",
                       padx=(0, SPACE_SM) if panel_index == 0 else (SPACE_SM, 0) if panel_index == 2 else (SPACE_SM, SPACE_SM))
            panel.columnconfigure(0, weight=1)
            ttk.Label(panel, text=panel_titles[panel_index], style="PanelTitle.TLabel").grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, SPACE_SM))
            fields = STRATEGY_FIELDS[panel_index * split:(panel_index + 1) * split]
            for row, (key, label, _default) in enumerate(fields, start=1):
                block = ttk.Frame(panel, style="Panel.TFrame"); block.grid(row=row, column=0, columnspan=2, sticky="ew", pady=(0, SPACE_XS)); block.columnconfigure(0, weight=1)
                ttk.Label(block, text=label, style="Muted.TLabel").grid(row=0, column=0, columnspan=2, sticky="w")
                entry = ttk.Entry(block, textvariable=self.setting_vars[key]); entry.grid(row=1, column=0, sticky="ew", pady=(SPACE_XS, 0), padx=(0, SPACE_SM))
                check = ttk.Checkbutton(block, text="Для монеты", variable=self.override_vars[key], command=self._toggle_settings_entries)
                check.grid(row=1, column=1, sticky="e", pady=(SPACE_XS, 0)); self.settings_entries[key] = entry; self.settings_checks[key] = check

        footer = ttk.Frame(container); footer.grid(row=3, column=0, sticky="ew", pady=(SPACE_MD, 0)); footer.columnconfigure(0, weight=1)
        self.settings_status = ttk.Label(footer, text="", style="Subtitle.TLabel"); self.settings_status.grid(row=0, column=0, sticky="w")
        self.settings_reset_button = ttk.Button(footer, text="Сбросить настройки монеты", command=self._reset_symbol_settings)
        self.settings_reset_button.grid(row=0, column=1, padx=(SPACE_SM, 0))
        ttk.Button(footer, text="Закрыть", command=self._close_settings_window).grid(row=0, column=2, padx=(SPACE_SM, 0))
        self.settings_save_button = ttk.Button(footer, text="Сохранить", style="Primary.TButton", command=self._save_settings_dialog)
        self.settings_save_button.grid(row=0, column=3, padx=(SPACE_SM, 0))
        self.settings_scope_var.set("global"); self._load_settings_scope()

    def _close_settings_window(self) -> None:
        if self.settings_window and self.settings_window.winfo_exists(): self.settings_window.destroy()
        self.settings_window = None; self.settings_entries.clear(); self.settings_checks.clear()
        self.settings_status = None; self.settings_save_button = None; self.settings_reset_button = None

    def _load_settings_scope(self) -> None:
        profile = self._settings_profile(); global_values = profile.get("global") or {}
        symbol = self._normalized_symbol(False) or str(profile.get("lastSymbol") or "BTCUSDT")
        overrides = (profile.get("symbols") or {}).get(symbol) or {}; per_symbol = self.settings_scope_var.get() == "symbol"
        self.applying_settings = True
        try:
            self.settings_mode_var.set("Live" if profile.get("mode") == "live" else "Paper Test" if profile.get("paperFast") else "Paper")
            for key, _label, default in STRATEGY_FIELDS:
                self.override_vars[key].set(per_symbol and key in overrides)
                value = overrides.get(key, global_values.get(key)) if per_symbol else global_values.get(key)
                self.setting_vars[key].set(self._setting_text(value, default))
        finally:
            self.applying_settings = False
        if self.settings_status:
            self.settings_status.configure(text=f"Настройки {symbol}" if per_symbol else "Базовые настройки для всех монет", foreground=COLORS["muted"])
        self._toggle_settings_entries()

    def _settings_locked(self) -> bool:
        phase = str(self.state.get("phase") or "disconnected")
        return self.action_pending or self.closing or phase in {"connecting", "configuring", "submitting", "canceling", "protecting", "closing", "flattening"} or bool(self.state.get("running") or self.state.get("activeOrder") or self.state.get("position") or self.state.get("recovery"))

    def _toggle_settings_entries(self) -> None:
        if not self.settings_window or not self.settings_window.winfo_exists(): return
        per_symbol = self.settings_scope_var.get() == "symbol"; locked = self._settings_locked()
        for key, _label, _default in STRATEGY_FIELDS:
            self.settings_checks[key].configure(state="disabled" if locked or not per_symbol else "normal")
            enabled = not locked and (not per_symbol or self.override_vars[key].get())
            self.settings_entries[key].configure(state="normal" if enabled else "disabled")
        self.settings_mode_combo.configure(state="disabled" if locked else "readonly")
        self.settings_save_button.configure(state="disabled" if locked else "normal")
        self.settings_reset_button.configure(state="normal" if per_symbol and not locked else "disabled")

    def _read_strategy_settings(self, overrides_only: bool = False) -> dict[str, int | float]:
        values: dict[str, int | float] = {}
        for key, label, _default in STRATEGY_FIELDS:
            if overrides_only and not self.override_vars[key].get(): continue
            raw = self.setting_vars[key].get().strip().replace(",", ".")
            try: value: int | float = int(raw) if key in INTEGER_SETTINGS else float(raw)
            except ValueError as error: raise ValueError(f"{label}: некорректное число") from error
            values[key] = value
        effective = {**(self._settings_profile().get("global") or {}), **values}
        if number(effective.get("minimumHoldMs")) is not None and number(effective.get("maxHoldSeconds")) is not None and float(effective["minimumHoldMs"]) >= float(effective["maxHoldSeconds"]) * 1000:
            raise ValueError("Минимальное удержание должно быть короче максимального")
        return values

    def _save_settings_dialog(self) -> None:
        try:
            per_symbol = self.settings_scope_var.get() == "symbol"; values = self._read_strategy_settings(per_symbol)
        except ValueError as error:
            if self.settings_status: self.settings_status.configure(text=str(error), foreground=COLORS["red"])
            return
        selected_mode = self.settings_mode_var.get().lower(); symbol = self._normalized_symbol(False) or str(self._settings_profile().get("lastSymbol") or "BTCUSDT")
        payload: dict[str, Any] = {"symbol": symbol, "mode": "live" if selected_mode == "live" else "paper", "paperFast": selected_mode == "paper test"}
        if per_symbol: payload.update({"settingsSymbol": symbol, "symbolSettings": values})
        else: payload["globalSettings"] = values
        if self.settings_status: self.settings_status.configure(text="Сохраняем локально…", foreground=COLORS["muted"])
        self.client.request("save_settings", payload, self._settings_saved)

    def _settings_saved(self, response: dict[str, Any]) -> None:
        if not response.get("ok"):
            message = str((response.get("error") or {}).get("message") or "Настройки не сохранены")
            if self.settings_status: self.settings_status.configure(text=message, foreground=COLORS["red"])
            return
        result = response.get("result") or {}; self.state["settings"] = result.get("settings") or self.state.get("settings") or {}
        self.state["settingsProfile"] = result.get("settingsProfile") or self.state.get("settingsProfile") or {}
        self._load_effective_settings(str((self.state.get("settings") or {}).get("symbol") or self.symbol_var.get()))
        self._load_settings_scope()
        if self.settings_status: self.settings_status.configure(text="Сохранено локально", foreground=COLORS["green"])
        self._append_log("Настройки стратегии сохранены", "ok")

    def _reset_symbol_settings(self) -> None:
        symbol = self._normalized_symbol(False) or str(self._settings_profile().get("lastSymbol") or "BTCUSDT")
        if self.settings_status: self.settings_status.configure(text=f"Сбрасываем {symbol} к глобальным…", foreground=COLORS["muted"])
        self.client.request("save_settings", {"symbol": symbol, "settingsSymbol": symbol, "resetSymbolSettings": True}, self._settings_saved)

    def _poll(self) -> None:
        self.client.poll()
        if self.root.winfo_exists():
            self.poll_job = self.root.after(40, self._poll)

    def _bind_form(self) -> None:
        if self.variable_traces:
            return
        for variable in [self.profile_var, self.symbol_var]:
            trace = variable.trace_add("write", self._draft_changed)
            self.variable_traces.append((variable, trace))

    def _draft_changed(self, *_args: Any) -> None:
        if not self.form_ready or self.applying_settings:
            return
        self.form_dirty = True; self.draft_revision += 1; self._update_mode_badge()
        if self.save_job:
            try: self.root.after_cancel(self.save_job)
            except tk.TclError: pass
        revision = self.draft_revision
        self.save_job = self.root.after(450, lambda: self._save_draft(revision))

    def _normalized_symbol(self, strict: bool = False) -> str | None:
        raw = self.symbol_var.get().strip().upper().replace("_", "").replace("-", "")
        if not raw or not raw.isalnum():
            return None
        if raw.endswith("USDT"):
            return raw
        candidate = f"{raw}USDT"
        if strict or candidate in self.symbols:
            return candidate
        return None

    def _draft_payload(self, strict: bool = False, include_strategy: bool = True) -> dict[str, Any] | None:
        selected_mode = self.mode_var.get().lower()
        payload: dict[str, Any] = {"mode": "live" if selected_mode == "live" else "paper", "paperFast": selected_mode == "paper test"}
        symbol = self._normalized_symbol(strict)
        if symbol:
            payload["symbol"] = symbol
        profile_id = self.profile_map.get(self.profile_var.get())
        if profile_id:
            payload["profileId"] = profile_id
        if include_strategy:
            effective = self._effective_for_symbol(symbol)
            payload.update({key: effective.get(key) for key, _label, _default in STRATEGY_FIELDS})
        if strict and symbol is None:
            self._set_detail("Проверьте выбранную монету", error=True); return None
        return payload

    def _save_draft(self, revision: int | None = None, callback: Callable[[dict[str, Any]], None] | None = None) -> None:
        self.save_job = None; payload = self._draft_payload(False, include_strategy=False)
        if not payload:
            if callback: callback({"ok": True, "result": {}})
            return
        expected = self.draft_revision if revision is None else revision
        self.client.request("save_settings", payload, lambda response: self._draft_saved(response, expected, callback))

    def _draft_saved(self, response: dict[str, Any], revision: int, callback: Callable[[dict[str, Any]], None] | None) -> None:
        if response.get("ok") and revision == self.draft_revision:
            self.form_dirty = False
            result = response.get("result") or {}; self.state["settings"] = result.get("settings") or self.state.get("settings") or {}
            self.state["settingsProfile"] = result.get("settingsProfile") or self.state.get("settingsProfile") or {}
        elif not response.get("ok") and not self.closing:
            self._append_log(str((response.get("error") or {}).get("message") or "Настройки не сохранены"), "error")
        if callback:
            callback(response)

    def _filter_symbols(self, _event: tk.Event[Any] | None = None) -> None:
        query = self.symbol_var.get().strip().upper().replace("_", "").replace("-", "")
        if not query:
            matches = self.symbols
        else:
            starts = [symbol for symbol in self.symbols if symbol.startswith(query) or symbol.removesuffix("USDT").startswith(query)]
            contains = [symbol for symbol in self.symbols if query in symbol and symbol not in starts]
            matches = starts + contains
        self.symbol_combo.configure(values=matches[:250])
        total = len(self.symbols); self.symbol_label.configure(text="Монета / поиск" if not total else f"Монета / поиск · {len(matches)}/{total}")

    def _render_analyzer_rows(self) -> None:
        if not hasattr(self, "analyzer_tree"):
            return
        selected_symbol = None
        selected = self.analyzer_tree.selection()
        if selected:
            selected_symbol = str(self.analyzer_tree.item(selected[0], "values")[1])
        query = self.analyzer_search_var.get().strip().upper().replace("_", "").replace("-", "")
        mode = self.analyzer_filter_var.get()
        rows = []
        for item in self.analyzer_rows:
            symbol = str(item.get("symbol") or "")
            if query and query not in symbol:
                continue
            if mode == "Готовы Live" and not item.get("eligibleForLive"):
                continue
            if mode == "Есть сделки" and int(number(item.get("adaptiveTrades")) or 0) <= 0:
                continue
            if mode == "Заблокированы" and not item.get("blockedReason"):
                continue
            rows.append(item)
        self.analyzer_tree.delete(*self.analyzer_tree.get_children())
        selected_id = None
        reasons = {"daily_loss_limit": "5 losses", "repeated_daily_cap": "demoted", "protection_failed": "guard fail"}
        for rank, item in enumerate(rows[:300], start=1):
            trades = int(number(item.get("adaptiveTrades")) or 0); win_rate = number(item.get("adaptiveWinRate")); fill_rate = number(item.get("adaptiveFillRate"))
            net = number(item.get("adaptiveNet")) or 0; lag = number(item.get("lagMs")); blocked = str(item.get("blockedReason") or "")
            status = reasons.get(blocked, "DEMOTED" if item.get("priorityDemoted") else "LIVE READY" if item.get("eligibleForLive") else "LEARNING" if trades else "QUEUE")
            values = (rank, item.get("symbol") or "n/a", str(item.get("leader") or "n/a").upper(),
                      f"{(number(item.get('thresholdBps')) or 0) / 100:.2f}%", trades,
                      "n/a" if win_rate is None else f"{win_rate * 100:.0f}%", f"{net:+.3f}",
                      "n/a" if fill_rate is None else f"{fill_rate * 100:.0f}%", "n/a" if lag is None else f"{lag:.0f} ms", status)
            tag = "blocked" if blocked else "positive" if net > 0 else "negative" if net < 0 else ""
            row_id = self.analyzer_tree.insert("", "end", values=values, tags=(tag,) if tag else ())
            if item.get("symbol") == selected_symbol:
                selected_id = row_id
        if selected_id:
            self.analyzer_tree.selection_set(selected_id); self.analyzer_tree.see(selected_id)

    def _select_analyzer_symbol(self, _event: tk.Event[Any] | None = None) -> None:
        selected = self.analyzer_tree.selection()
        if not selected:
            return
        values = self.analyzer_tree.item(selected[0], "values")
        if len(values) < 2:
            return
        self.symbol_var.set(str(values[1])); self._symbol_selected(); self._append_log(f"Выбрана монета из анализатора: {values[1]}", "ok")

    def _show_analyzer_detail(self, _event: tk.Event[Any] | None = None) -> None:
        selected = self.analyzer_tree.selection()
        if not selected:
            return
        values = self.analyzer_tree.item(selected[0], "values")
        if len(values) < 2:
            return
        symbol = str(values[1]); item = next((row for row in self.analyzer_rows if row.get("symbol") == symbol), None)
        if not item:
            return
        trades = int(number(item.get("adaptiveTrades")) or 0); wins = number(item.get("adaptiveWinRate")); fills = number(item.get("adaptiveFillRate"))
        self.candidate_detail.configure(text=(f"{symbol} | {str(item.get('leader') or 'n/a').upper()} | порог {(number(item.get('thresholdBps')) or 0) / 100:.2f}% | "
                                              f"Paper {trades} сделок, WR {'n/a' if wins is None else f'{wins * 100:.0f}%'}, fill {'n/a' if fills is None else f'{fills * 100:.0f}%'} | "
                                              f"net {fmt_money(item.get('adaptiveNet'))} | losses сегодня {int(number(item.get('dailyLosses')) or 0)}/5 | "
                                              f"серия лимитов {int(number(item.get('capStreak')) or 0)}/3"),
                                        foreground=COLORS["red"] if item.get("blockedReason") else COLORS["green"] if item.get("eligibleForLive") else COLORS["muted"])

    def _apply_analyzer(self, analyzer: dict[str, Any]) -> None:
        self.analyzer = analyzer or {}; self.analyzer_rows = list(self.analyzer.get("rows") or [])
        totals = self.analyzer.get("totals") or {}; universe = self.analyzer.get("universe") or {}
        running = bool(self.analyzer.get("running")); starting = bool(self.analyzer.get("starting")); error = self.analyzer.get("error")
        label = "АНАЛИЗАТОР: LIVE" if running else "АНАЛИЗАТОР: ЗАПУСК" if starting else "АНАЛИЗАТОР: ПАУЗА"
        self.analyzer_badge.configure(text=label, background=COLORS["green_soft"] if running else COLORS["red_soft"] if error else COLORS["panel_alt"],
                                      foreground=COLORS["green"] if running else COLORS["red"] if error else COLORS["muted"])
        self.analyzer_toggle_button.configure(text="Пауза анализа" if running or starting else "Продолжить анализ")
        count = int(number(totals.get("symbols")) or number(universe.get("lbank")) or 0)
        self.analyzer_metrics["symbols"].configure(text=str(count)); self.analyzer_metrics["trades"].configure(text=str(int(number(totals.get("trades")) or 0)))
        self.analyzer_metrics["net"].configure(text=fmt_money(totals.get("net")), foreground=COLORS["green"] if (number(totals.get("net")) or 0) >= 0 else COLORS["red"])
        self.analyzer_metrics["ready"].configure(text=str(int(number(totals.get("liveReady")) or 0)), foreground=COLORS["green"])
        if error:
            message = error.get("message") if isinstance(error, dict) else str(error); self.analyzer_detail.configure(text=f"Ошибка публичных потоков: {message}", foreground=COLORS["red"])
        else:
            self.analyzer_detail.configure(text=f"LBank {universe.get('lbank', 0)} | Binance {universe.get('lbankBinance', 0)} | MEXC {universe.get('lbankMexc', 0)} | настройки 0,02-0,08%", foreground=COLORS["muted"])
        self._render_analyzer_rows()
        candidate = next((row for row in self.analyzer_rows if row.get("eligibleForLive") and not row.get("blockedReason")), None)
        if candidate:
            self.candidate_detail.configure(text=(f"Первый кандидат: {candidate.get('symbol')} | {str(candidate.get('leader') or '').upper()} | "
                                                  f"порог {(number(candidate.get('thresholdBps')) or 0) / 100:.2f}% | "
                                                  f"Paper net {fmt_money(candidate.get('adaptiveNet'))} | дневные losses {int(number(candidate.get('dailyLosses')) or 0)}/5"), foreground=COLORS["green"])
        else:
            self.candidate_detail.configure(text="Кандидаты появятся после минимум трёх исполненных Paper-сделок и неотрицательного net ожидания", foreground=COLORS["muted"])

    def _apply_portfolio(self, portfolio: dict[str, Any]) -> None:
        self.portfolio = portfolio or {}; running = bool(self.portfolio.get("running")); current = self.portfolio.get("current") or {}
        reason = str(self.portfolio.get("waitingReason") or "paused")
        labels = {"paused": "PAUSED", "selecting_candidate": "ВЫБОР МОНЕТЫ", "no_validated_candidate": "ЖДЁМ КАНДИДАТА",
                  "global_cooldown": "GLOBAL COOLDOWN", "configuring": "НАСТРОЙКА", "trading": "ТОРГУЕМ", "error": "ОШИБКА"}
        suffix = f" | {current.get('symbol')}" if current.get("symbol") else ""
        next_at = number(self.portfolio.get("nextEntryAt"))
        if reason == "global_cooldown" and next_at:
            suffix += f" | {max(0, (next_at - time.time() * 1000) / 1000):.0f} сек"
        self.portfolio_status.configure(text=f"AUTO LIVE: {labels.get(reason, reason.upper())}{suffix}", foreground=COLORS["green"] if running else COLORS["muted"])
        self._apply_control_states()

    def _toggle_analyzer(self) -> None:
        command = "analyzer_pause" if self.analyzer.get("running") or self.analyzer.get("starting") else "analyzer_start"
        self.client.request(command, {}, lambda response: self._after_action(response, "Анализатор обновлён"))

    def _profiles(self) -> None:
        self._set_detail("Читаем запущенные профили Undetectable…")
        self.client.request("profiles", {}, self._profiles_result)

    def _profiles_result(self, response: dict[str, Any]) -> None:
        if not response.get("ok"):
            self._show_error(response); return
        rows = response.get("result") or []; previous = self.profile_var.get(); self.profile_map.clear(); values = []
        for row in rows:
            display = f"{row.get('name') or row.get('id')} · {row.get('status') or 'Unknown'} · {row.get('id')}"
            values.append(display); self.profile_map[display] = str(row.get("id"))
        self.profile_combo.configure(values=values)
        preferred = str((self.state.get("settings") or {}).get("profileId") or "")
        selected = previous if previous in self.profile_map else next((value for value in values if self.profile_map[value] == preferred), values[0] if values else "")
        self.applying_settings = True
        try: self.profile_var.set(selected)
        finally: self.applying_settings = False
        self._set_detail(f"Найдено профилей: {len(values)}")
        if self.auto_live_requested and selected and not self.auto_live_connecting and not self.auto_live_started:
            self.auto_live_connecting = True
            self.applying_settings = True
            try:
                self.mode_var.set("Live")
                if self.live_symbol: self.symbol_var.set(self.live_symbol)
            finally: self.applying_settings = False
            if self.state.get("recovery"):
                profile_id = self.profile_map[selected]
                self.action_pending = True; self._apply_control_states(); self._set_detail("Подключаемся для безопасной сверки…")
                self.client.request("connect", {"profileId": profile_id}, self._connected)
            else:
                self.root.after(0, self._connect)

    def _connect(self) -> None:
        profile_id = self.profile_map.get(self.profile_var.get())
        if not profile_id:
            self._set_detail("Выберите запущенный профиль Undetectable", error=True); return
        self.action_pending = True; self.draft_revision += 1
        if self.save_job:
            try: self.root.after_cancel(self.save_job)
            except tk.TclError: pass
            self.save_job = None
        self._apply_control_states(); self._set_detail("Сохраняем настройки перед подключением…")
        self._save_draft(self.draft_revision, lambda response: self._saved_then_connect(response, profile_id))

    def _saved_then_connect(self, response: dict[str, Any], profile_id: str) -> None:
        if not response.get("ok"):
            self.action_pending = False; self._show_error(response); return
        self._set_detail("Подключаем Futures-вкладку LBank…")
        self.client.request("connect", {"profileId": profile_id}, self._connected)

    def _connected(self, response: dict[str, Any]) -> None:
        self._after_action(response, "Профиль LBank подключён")
        if response.get("ok"):
            self.client.request("symbols", {}, self._symbols_result)
            if self.auto_live_requested and not self.auto_live_started:
                self.auto_live_started = True
                if self.state.get("recovery") or self.state.get("activeOrder") or self.state.get("position") or self.state.get("protection"):
                    self.action_pending = True; self._apply_control_states(); self._set_detail("Сверяем незавершённое состояние…")
                    self.client.request("flatten", {}, self._auto_flattened_then_portfolio)
                else:
                    self._start_requested_live()
        else:
            self.auto_live_connecting = False

    def _auto_flattened_then_portfolio(self, response: dict[str, Any]) -> None:
        self.action_pending = False
        if not response.get("ok"):
            self._show_error(response); return
        self._append_log("LBank подтверждён flat после восстановления", "ok")
        self._start_requested_live()

    def _start_requested_live(self) -> None:
        if self.live_symbol:
            effective = self._effective_for_symbol(self.live_symbol)
            payload = {**{key: effective.get(key, number(default)) for key, _label, default in STRATEGY_FIELDS},
                       "symbol": self.live_symbol, "mode": "live", "paperFast": False,
                       "autoPosition": True, "reserveFraction": .1, "warmupSeconds": 0}
            self.action_pending = True; self._apply_control_states(); self._set_detail(f"Проверяем {self.live_symbol} и лимит риска…")
            self.client.request("configure", payload, self._auto_symbol_configured)
            return
        self.action_pending = True; self._apply_control_states(); self._set_detail("Запускаем AUTO LIVE…")
        self.client.request("portfolio_start", {}, lambda result: self._after_action(result, "Автоматический Live-режим запущен"))

    def _auto_symbol_configured(self, response: dict[str, Any]) -> None:
        if not response.get("ok"):
            self.action_pending = False; self._show_error(response); return
        self.client.request("start", {}, lambda result: self._after_action(result, f"Live {self.live_symbol} запущен"))

    def _symbols_result(self, response: dict[str, Any]) -> None:
        if not response.get("ok"):
            self._show_error(response); return
        self.symbols = [str(symbol) for symbol in (response.get("result") or [])]
        self._filter_symbols(); self._set_detail(f"Доступно LBank Futures-контрактов: {len(self.symbols)}")

    def _config_payload(self) -> dict[str, Any] | None:
        payload = self._draft_payload(True)
        if not payload:
            return None
        keys = ["symbol", "mode", "paperFast", *[key for key, _label, _default in STRATEGY_FIELDS]]
        return {key: payload[key] for key in keys}

    def _portfolio_start(self) -> None:
        if self.mode_var.get().lower() != "live":
            self._set_detail("Для реального портфельного режима сначала выберите Live в настройках", error=True); return
        self.action_pending = True; self._apply_control_states(); self._set_detail("Выбираем лучшую подтверждённую монету из Paper-анализатора...")
        self.client.request("portfolio_start", {}, lambda response: self._after_action(response, "Автоматический Live-режим запущен"))

    def _start(self) -> None:
        payload = self._config_payload()
        if not payload:
            return
        self.start_token += 1
        token = self.start_token
        self.draft_revision += 1
        if self.save_job:
            try: self.root.after_cancel(self.save_job)
            except tk.TclError: pass
            self.save_job = None
        self.action_pending = True; self._apply_control_states(); self._set_detail("Проверяем рынок, комиссии и параметры…")
        metadata = {"symbol": payload["symbol"], "mode": payload["mode"], "paperFast": payload["paperFast"],
                    **({"profileId": self.profile_map[self.profile_var.get()]} if self.profile_var.get() in self.profile_map else {})}
        self.client.request("save_settings", metadata,
                            lambda response: self._saved_then_configure(response, payload, token))

    def _saved_then_configure(self, response: dict[str, Any], payload: dict[str, Any], token: int) -> None:
        if token != self.start_token:
            return
        if not response.get("ok"):
            self.action_pending = False; self._show_error(response); return
        self.form_dirty = False; self.client.request("configure", payload, lambda result: self._configured_then_start(result, token))

    def _configured_then_start(self, response: dict[str, Any], token: int) -> None:
        if token != self.start_token:
            return
        if not response.get("ok"):
            self.action_pending = False; self._show_error(response); return
        self.client.request("start", {}, lambda result: self._start_result(result, token))

    def _start_result(self, response: dict[str, Any], token: int) -> None:
        if token == self.start_token:
            self._after_action(response, "Стратегия запущена")

    def _pause(self) -> None:
        self.start_token += 1
        self.action_pending = True; self._apply_control_states()
        self.client.request("portfolio_pause", {}, lambda response: self._after_action(response, "Новые входы поставлены на паузу"))

    def _flatten(self) -> None:
        self.start_token += 1
        self.action_pending = True; self._apply_control_states()
        self._set_detail("Отменяем вход и закрываем подтверждённый объём…")
        self.client.request("flatten", {}, lambda response: self._after_action(response, "LBank подтверждён flat"))

    def _after_action(self, response: dict[str, Any], success: str) -> None:
        self.action_pending = False
        self._apply_control_states()
        if not response.get("ok"):
            self._show_error(response); return
        self._append_log(success, "ok")

    def _show_error(self, response: dict[str, Any]) -> None:
        self._apply_control_states()
        error = response.get("error") or {}; self._set_detail(str(error.get("message") or "Неизвестная ошибка"), error=True)
        self._append_log(str(error.get("message") or "Неизвестная ошибка"), "error")

    def _on_message(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if kind == "hello":
            self._apply_state(message.get("state") or {}, force_settings=True); self.form_ready = True; self._bind_form()
            self._append_log("Sidecar v1 готов", "ok"); self._profiles()
        elif kind == "state":
            self._apply_state(message.get("state") or {})
        elif kind == "market":
            self.market = message.get("market") or {}; self.market_received = time.monotonic(); self._apply_market()
        elif kind in {"analyzer", "analyzer_state"}:
            self._apply_analyzer(message.get("analyzer") or {})
        elif kind == "portfolio":
            self._apply_portfolio(message.get("portfolio") or {})
        elif kind == "pnl":
            pnl = message.get("pnl") or {}; self.current_pnl = number(pnl.get("net")); self._update_pnl_display()
        elif kind == "order":
            test_fill = " · тестовый fill" if message.get("simulatedTestFill") else ""
            order = message.get("order") or {}; route = str(order.get("type") or "LIMIT").upper()
            order_price = number(order.get("avgPrice")) or number(order.get("price"))
            order_notional = order_price * number(order.get("quantity")) if order_price is not None and number(order.get("quantity")) is not None else None
            nominal_text = f" ≈ {fmt_money(order_notional)}" if order_notional is not None else ""
            self._append_log(f"Ордер: {message.get('action')} · {route} {order.get('side') or 'n/a'} {fmt_price(order.get('quantity'))} @ {fmt_price(order_price)}{nominal_text} · "
                             f"{order.get('orderId') or order.get('clientOrderId') or 'n/a'}{test_fill}", "info")
        elif kind == "position":
            if message.get("action") == "closed":
                self.current_pnl = None; self._update_pnl_display()
                result = message.get("result") or {}
                self._append_log(f"Позиция закрыта · {exit_reason_text(message.get('reason'))} · gross {fmt_money(result.get('gross'))} · fees {fmt_money(result.get('fees'))} · net {fmt_money(result.get('net'))}",
                                 "ok" if (number(result.get("net")) or 0) >= 0 else "error")
            else:
                self._append_log(f"Позиция: {message.get('action')} · {exit_reason_text(message.get('reason')) if message.get('reason') else ''}", "info")
        elif kind == "protection":
            self._append_log(f"Защита: {message.get('action')}", "ok" if message.get("action") == "confirmed" else "info")
        elif kind == "stream":
            self._append_log(f"{str(message.get('venue')).upper()} stream: {message.get('state')}", "info")
        elif kind == "error":
            error = message.get("error") or {}; self._set_detail(str(error.get("message") or "Ошибка ядра"), error=True); self._append_log(str(error.get("message") or "Ошибка ядра"), "error")
            self.alarm = bool(message.get("alarm")); self._alarm_tick()
        elif kind == "diagnostic":
            self._append_log(str(message.get("message") or ""), "error")
        elif kind == "process_exit":
            self._set_detail(f"Sidecar остановлен, код {message.get('code')}", error=not self.closing)
            if self.closing:
                self._cancel_after_jobs(); self.root.destroy()

    def _apply_control_states(self) -> None:
        phase = str(self.state.get("phase") or "disconnected")
        busy = phase in {"connecting", "configuring", "submitting", "canceling", "protecting", "closing", "flattening"}
        exposed = bool(self.state.get("running") or self.state.get("activeOrder") or self.state.get("position") or self.state.get("recovery"))
        locked = busy or exposed or self.action_pending or self.closing
        self.profile_combo.configure(state="disabled" if locked else "readonly")
        self.refresh_profiles_button.configure(state="disabled" if locked else "normal")
        self.symbol_combo.configure(state="disabled" if locked else "normal")
        self.connect_button.configure(state="disabled" if locked else "normal")
        self.start_button.configure(state="disabled" if locked else "normal")
        portfolio_running = bool(self.portfolio.get("running"))
        auto_disabled = locked or portfolio_running or self.mode_var.get().lower() != "live" or not bool(self.state.get("connected"))
        self.auto_start_button.configure(state="disabled" if auto_disabled else "normal")
        self.settings_button.configure(state="disabled" if self.closing else "normal")
        self._toggle_settings_entries()

    def _apply_state(self, state: dict[str, Any], force_settings: bool = False) -> None:
        self.state = state
        settings = state.get("settings") or {}
        if settings and not state.get("running") and (force_settings or not self.form_dirty):
            self.applying_settings = True
            try:
                self.symbol_var.set(str(settings.get("symbol") or self.symbol_var.get()))
                for key, _label, default in STRATEGY_FIELDS:
                    self.setting_vars[key].set(self._setting_text(settings.get(key), default))
                self.mode_var.set("Live" if settings.get("mode") == "live" else "Paper Test" if settings.get("paperFast") else "Paper")
                if force_settings: self.form_dirty = False
            finally:
                self.applying_settings = False
        self._update_mode_badge(); self._update_settings_summary()
        budget = (state.get("config") or {}).get("automaticBudget") or {}
        if budget:
            self.settings_summary.configure(text=(f"AUTO лимит: {fmt_money(budget.get('nominal'))} номинал · "
                                                  f"{fmt_money(budget.get('margin'))} маржи при {int(number(budget.get('leverage')) or 1)}x · "
                                                  f"плановый риск ≤{fmt_money(budget.get('riskBudget'))} "
                                                  f"({fmt_price(budget.get('maxLossPercent'))}% баланса)"))
        phase = str(state.get("phase") or "disconnected"); attention = bool(state.get("requiresAttention")); running = bool(state.get("running"))
        color = COLORS["red"] if attention or state.get("error") else COLORS["green"] if running or phase in {"ready", "connected", "position"} else COLORS["amber"] if phase in {"warming_up", "cooldown", "connecting", "configuring"} else COLORS["muted"]
        self.phase_dot.itemconfigure(self.dot_id, fill=color); self.phase_label.configure(text=phase_text(phase))
        error = state.get("error") or {}; detail = error.get("message") if isinstance(error, dict) else str(error)
        if not detail:
            reference = str(state.get("reference") or "n/a").upper(); threshold = number(settings.get("impulsePercent")) or 0.04
            detail = f"Ведущая: {reference} | isolated | {threshold:g}% / 1 сек"
        self.detail_label.configure(text=detail, foreground=COLORS["red"] if error else COLORS["muted"])
        reference = str(state.get("reference") or "n/a").upper(); self.signal_values["direction"].configure(text=f"{reference} | n/a")
        order = state.get("activeOrder"); position = state.get("position")
        order_nominal = (number(order.get("quantity")) or 0) * (number(order.get("avgPrice")) or number(order.get("price")) or 0) if order else None
        position_nominal = (number(position.get("quantity")) or 0) * (number(position.get("avgPrice")) or 0) if position else None
        leverage = number((state.get("config") or {}).get("leverage")) or 1
        self.signal_values["order"].configure(text="n/a" if not order else f"{order.get('type') or 'LIMIT'} | {order.get('side')} ≈ {fmt_money(order_nominal)}")
        self.signal_values["position"].configure(text="n/a" if not position else f"{position.get('side')} ≈ {fmt_money(position_nominal)} · маржа {fmt_money(position_nominal / leverage)}")
        if not position: self.signal_values["hold"].configure(text="n/a", foreground=COLORS["muted"])
        self._update_pnl_display()
        if not position:
            self.alarm = False
        self._apply_control_states()

    def _apply_market(self, elapsed_ms: int = 0) -> None:
        venues = self.market.get("venues") or {}
        for venue, panel in self.venues.items(): panel.update_data(venues.get(venue), elapsed_ms)
        evaluation = self.market.get("evaluation") or {}; leader = str(self.market.get("leader") or "n/a").upper()
        direction = str(evaluation.get("direction") or "").upper(); qualified = bool(evaluation.get("side"))
        arrow = "↑" if direction == "BUY" else "↓" if direction == "SELL" else "-"
        direction_color = COLORS["green"] if direction == "BUY" else COLORS["red"] if direction == "SELL" else COLORS["muted"]
        signal_suffix = " · СИГНАЛ" if qualified else ""
        self.signal_values["direction"].configure(text=f"{leader} · {arrow} {direction or 'FLAT'}{signal_suffix}", foreground=direction_color)
        threshold = number(evaluation.get("thresholdBps")); impulse = fmt_bps(evaluation.get("impulseBps"))
        self.signal_values["impulse"].configure(text=impulse if threshold is None else f"{impulse} / ±{threshold:g}")
        self.signal_values["basis"].configure(text=fmt_bps(self.market.get("basisBps")))
        gross = number(evaluation.get("grossBps")); edge = number(evaluation.get("netEdgeBps"))
        edge_text = f"{fmt_bps(gross)} / {fmt_bps(edge)}"
        self.signal_values["edge"].configure(text=edge_text, foreground=COLORS["green"] if evaluation.get("eligible") else COLORS["muted"])
        entry_type = str(evaluation.get("entryType") or "n/a").upper(); impact = number(evaluation.get("entryImpactBps")); coverage = number(evaluation.get("depthCoverage"))
        execution_text = entry_type
        if impact is not None: execution_text += f" · impact {impact:.2f} bps"
        if coverage is not None: execution_text += f" · depth ×{coverage:.1f}"
        allocated = number(evaluation.get("allocatedNotional"))
        if allocated is not None: execution_text += f" · {fmt_money(allocated)}"
        if evaluation.get("sizedDown"): execution_text += " · объём ограничен стаканом"
        self.signal_values["execution"].configure(text=execution_text, foreground=COLORS["green"] if entry_type in {"MARKET", "LIMIT"} else COLORS["muted"])
        decision = "PAPER TEST · ВХОД" if evaluation.get("paperFast") and not evaluation.get("lagEligible") else decision_text(evaluation.get("reason"), bool(evaluation.get("eligible")))
        self.signal_values["decision"].configure(text=decision,
                                                  foreground=COLORS["green"] if evaluation.get("eligible") else COLORS["amber"] if evaluation.get("side") else COLORS["muted"])
        control = self.market.get("positionControl") or {}
        if self.state.get("position") and control:
            age = (number(control.get("ageMs")) or 0) / 1000; best = number(control.get("bestFavorableBps")) or 0
            retrace = number(control.get("pullbackBps")) if number(control.get("pullbackBps")) is not None else number(control.get("retraceBps")) or 0
            lag = number(control.get("signedLagBps")); adverse = number(control.get("adverseBps")) or 0
            armed = bool(control.get("trailingArmed")); active = bool(control.get("signalActive")); minimum = number(control.get("minimumHoldRemainingMs")) or 0
            mode = "ТЯНЕМ ЛАГ" if active else "TRAIL ON" if armed else "MIN HOLD"
            label = f"{age:.1f}с · {mode} · лаг {lag:+.2f} bps" if lag is not None else f"{age:.1f}с · {mode}"
            label += f" · best {best:.2f} · откат {retrace:.2f} · adverse {adverse:.2f} bps"
            exit_net = number(control.get("exitNetBps"))
            if exit_net is not None: label += f" · exit net {exit_net:+.2f}"
            if minimum > 0: label += f" · min ещё {minimum / 1000:.1f}с"
            ready = armed and minimum <= 0
            self.signal_values["hold"].configure(text=label, foreground=COLORS["green"] if ready else COLORS["amber"])
        cooldown = number(evaluation.get("cooldownRemainingMs")) or 0
        if cooldown > 0 and self.state.get("phase") == "cooldown":
            self.detail_label.configure(text=f"Следующий вход не раньше чем через {cooldown / 1000:.1f} сек", foreground=COLORS["amber"])
        elif self.state.get("phase") in {"warming_up", "waiting"} and not self.state.get("error"):
            self._update_waiting_detail(evaluation)

    def _update_waiting_detail(self, evaluation: dict[str, Any]) -> None:
        reason = str(evaluation.get("reason") or "")
        if reason == "warming_up":
            remaining = number(self.market.get("warmingRemainingMs")) or 0
            text = "Ожидание первой свежей котировки"
        elif reason == "no_impulse":
            threshold = (number(evaluation.get("thresholdBps")) or 0) / 100; current = (number(evaluation.get("impulseBps")) or 0) / 100
            text = f"Ждём импульс ±{threshold:g}% · сейчас {current:+.5f}%"
        elif reason in {"edge_too_small", "lag_not_positive"}:
            gross = fmt_bps(evaluation.get("grossBps")); costs = fmt_bps(evaluation.get("costBps")); net = fmt_bps(evaluation.get("netEdgeBps"))
            text = f"{evaluation.get('direction') or 'Сигнал'}: лаг {gross} · расходы {costs} · net {net} (справочно)"
        elif evaluation.get("eligible"):
            text = f"Вход разрешён: расходы не участвуют в фильтре · расчётный net {fmt_bps(evaluation.get('netEdgeBps'))}"
        else:
            text = decision_text(reason, bool(evaluation.get("eligible")))
        self.detail_label.configure(text=text, foreground=COLORS["green"] if evaluation.get("eligible") else COLORS["muted"])

    def _update_pnl_display(self) -> None:
        value = self.current_pnl
        self.signal_values["pnl"].configure(text=fmt_money(value), foreground=COLORS["green"] if (value or 0) >= 0 else COLORS["red"])
        trades = int(number(self.state.get("sessionTrades")) or 0); wins = int(number(self.state.get("sessionWins")) or 0)
        losses = int(number(self.state.get("sessionLosses")) or 0); breakeven = int(number(self.state.get("sessionBreakeven")) or 0)
        win_rate = wins / trades * 100 if trades else 0
        self.signal_values["trades"].configure(text=f"{trades} · {wins}/{losses}/{breakeven} · {win_rate:.0f}% WR")
        gross = number(self.state.get("realizedGross")); fees = number(self.state.get("feesPaid")); net = number(self.state.get("realizedNet"))
        self.signal_values["session"].configure(text=f"{fmt_money(gross)} / {fmt_money(fees)} / {fmt_money(net)}",
                                                 foreground=COLORS["green"] if (net or 0) >= 0 else COLORS["red"])

    def _refresh_ages(self) -> None:
        if self.market:
            self._apply_market(int((time.monotonic() - self.market_received) * 1000))
        if self.root.winfo_exists(): self.age_job = self.root.after(250, self._refresh_ages)

    def _update_mode_badge(self) -> None:
        live = self.mode_var.get().lower() == "live"
        paper_test = self.mode_var.get().lower() == "paper test"
        self.mode_badge.configure(text="LIVE" if live else "PAPER TEST" if paper_test else "PAPER", background=COLORS["red"] if live else COLORS["amber"], foreground="#170407" if live else "#1b1202")

    def _set_detail(self, text: str, error: bool = False) -> None:
        self.detail_label.configure(text=text, foreground=COLORS["red"] if error else COLORS["muted"])

    def _append_log(self, text: str, tag: str = "info") -> None:
        clean = " ".join(str(text).split())[:500]; now = time.monotonic()
        if self.last_log and self.last_log[0] == clean and now - self.last_log[1] < 3:
            return
        self.last_log = (clean, now); stamp = time.strftime("%H:%M:%S")
        self._persist_log_line(f"{time.strftime('%Y-%m-%d')} {stamp}  [{tag.upper()}]  {clean}\n")
        selection = tuple(self.log.tag_ranges("sel")); should_follow = self.log_follow_tail and not selection
        self.log.configure(state="normal"); self.log.insert("end", f"{stamp}  {clean}\n", tag)
        lines = int(self.log.index("end-1c").split(".")[0])
        if lines > 600 and should_follow: self.log.delete("1.0", f"{lines - 500}.0")
        if should_follow: self.log.see("end")
        self.log.configure(state="disabled")

    def _on_log_scroll(self, first: str, last: str) -> None:
        self.log_scroll.set(first, last)
        self.log_follow_tail = float(last) >= 0.999
        self.log_tail_button.configure(text="AUTO" if self.log_follow_tail else "К последним",
                                       state="disabled" if self.log_follow_tail else "normal")

    def _jump_logs_to_end(self) -> None:
        self.log.see("end"); self.log_follow_tail = True
        self.log_tail_button.configure(text="AUTO", state="disabled")

    def _copy_log_selection(self, _event: Any = None) -> str:
        try:
            selected = self.log.get("sel.first", "sel.last")
        except tk.TclError:
            return "break"
        self._set_clipboard(selected)
        return "break"

    def _copy_logs(self) -> None:
        try: text = self.log.get("sel.first", "sel.last")
        except tk.TclError: text = self.log.get("1.0", "end-1c")
        if text: self._set_clipboard(text)

    def _set_clipboard(self, text: str) -> None:
        self.root.clipboard_clear(); self.root.clipboard_append(text); self.root.update_idletasks()
        self._set_detail(f"Скопировано строк: {max(1, text.count(chr(10)))}")

    def _select_all_logs(self, _event: Any = None) -> str:
        self.log.tag_add("sel", "1.0", "end-1c"); self.log.mark_set("insert", "1.0"); self.log.see("1.0")
        return "break"

    def _show_log_menu(self, event: tk.Event) -> str:
        has_selection = bool(self.log.tag_ranges("sel")); self.log_menu.entryconfigure("Копировать выделенное", state="normal" if has_selection else "disabled")
        try: self.log_menu.tk_popup(event.x_root, event.y_root)
        finally: self.log_menu.grab_release()
        return "break"

    def _load_saved_logs(self) -> None:
        if not self.log_path:
            if hasattr(self, "log_file_button"): self.log_file_button.configure(state="disabled")
            return
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            if not self.log_path.exists(): self.log_path.touch()
            lines = self.log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-300:]
            if lines:
                self.log.configure(state="normal"); self.log.insert("end", "\n".join(lines) + "\n", "info"); self.log.see("end"); self.log.configure(state="disabled")
        except OSError as error:
            if hasattr(self, "log_file_button"): self.log_file_button.configure(state="disabled")
            self._set_detail(f"Файл журнала недоступен: {error}", error=True)

    def _persist_log_line(self, line: str) -> None:
        if not self.log_path: return
        try:
            with self.log_io_lock:
                self.log_path.parent.mkdir(parents=True, exist_ok=True)
                if self.log_path.exists() and self.log_path.stat().st_size >= 5 * 1024 * 1024:
                    for index in range(3, 0, -1):
                        source = self.log_path if index == 1 else self.log_path.with_name(f"ui.log.{index - 1}")
                        target = self.log_path.with_name(f"ui.log.{index}")
                        if source.exists():
                            if target.exists(): target.unlink()
                            source.replace(target)
                with self.log_path.open("a", encoding="utf-8") as stream: stream.write(line)
        except OSError:
            pass

    def _open_log_file(self) -> None:
        if not self.log_path: return
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True); self.log_path.touch(exist_ok=True)
            if os.name == "nt": os.startfile(str(self.log_path))
            elif sys.platform == "darwin": subprocess.Popen(["open", str(self.log_path)])
            else: subprocess.Popen(["xdg-open", str(self.log_path)])
        except OSError as error: self._set_detail(f"Не удалось открыть журнал: {error}", error=True)

    def _alarm_tick(self) -> None:
        if not self.alarm:
            return
        try:
            if os.name == "nt":
                import winsound
                winsound.MessageBeep(winsound.MB_ICONHAND)
            else:
                self.root.bell()
        except Exception:
            pass
        self.alarm_job = self.root.after(1200, self._alarm_tick)

    def _cancel_after_jobs(self) -> None:
        for job in [self.poll_job, self.age_job, self.alarm_job, self.save_job]:
            if job:
                try: self.root.after_cancel(job)
                except tk.TclError: pass
        self.poll_job = self.age_job = self.alarm_job = self.save_job = None
        for variable, trace in self.variable_traces:
            try: variable.trace_remove("write", trace)
            except tk.TclError: pass
        self.variable_traces.clear()

    def _load_smoke_data(self) -> None:
        now = int(time.time() * 1000)
        self._apply_state({"phase": "waiting", "running": True, "mode": "paper", "reference": "binance", "realizedGross": 2.1, "feesPaid": .83, "realizedNet": 1.27,
                           "sessionTrades": 9, "sessionWins": 6, "sessionLosses": 3, "sessionBreakeven": 0,
                           "settings": {"symbol": "BTCUSDT", "nominal": 50, "leverage": 5, "impulsePercent": 0.04, "cooldownSeconds": 180, "mode": "paper", "paperFast": False}})
        levels = lambda price: {
            "bid": price - .1, "ask": price + .1, "spreadBps": .03, "bidDepthUsd": 53000, "askDepthUsd": 47000, "ageMs": 32,
            "bids": [{"price": price - .1 - i * .1, "quantity": .5 + i / 10} for i in range(8)],
            "asks": [{"price": price + .1 + i * .1, "quantity": .6 + i / 10} for i in range(8)],
        }
        self.market = {"leader": "binance", "basisBps": -1.4, "evaluation": {"impulseBps": 4.8, "netEdgeBps": 3.2}, "venues": {"lbank": levels(115000), "binance": levels(115020), "mexc": levels(115018)}, "at": now}
        self.market_received = time.monotonic(); self._apply_market(); self._append_log("Smoke: интерфейс получает потоковые снимки", "ok")
        rows = [
            {"symbol": "PONSUSDT", "leader": "binance", "thresholdBps": 3, "adaptiveTrades": 18, "adaptiveWinRate": .56,
             "adaptiveFillRate": .71, "adaptiveNet": 1.24, "lagMs": 930, "eligibleForLive": True, "dailyLosses": 1},
            {"symbol": "DASHUSDT", "leader": "binance", "thresholdBps": 4, "adaptiveTrades": 11, "adaptiveWinRate": .45,
             "adaptiveFillRate": .64, "adaptiveNet": -.12, "lagMs": 540, "eligibleForLive": True, "dailyLosses": 2},
            {"symbol": "ZECUSDT", "leader": "binance", "thresholdBps": 5, "adaptiveTrades": 9, "adaptiveWinRate": .33,
             "adaptiveFillRate": .58, "adaptiveNet": -.83, "lagMs": 780, "eligibleForLive": False, "blockedReason": "daily_loss_limit", "dailyLosses": 5},
        ]
        self._apply_analyzer({"running": True, "universe": {"lbank": 286, "lbankBinance": 144, "lbankMexc": 231},
                              "totals": {"symbols": 249, "trades": 38, "net": .29, "liveReady": 2}, "rows": rows})

    def _close(self) -> None:
        if self.closing:
            return
        self.closing = True; self.form_ready = False; self.start_token += 1; self.draft_revision += 1
        if self.save_job:
            try: self.root.after_cancel(self.save_job)
            except tk.TclError: pass
            self.save_job = None
        self._apply_control_states(); self._set_detail("Сохраняем настройки и безопасно завершаем sidecar…")
        self._save_draft(self.draft_revision, lambda _response: self._request_shutdown())

    def _request_shutdown(self) -> None:
        self._set_detail("Безопасно завершаем sidecar и закрываем подтверждённую позицию…")
        self.client.request("shutdown", {}, self._shutdown_result)

    def _shutdown_result(self, response: dict[str, Any]) -> None:
        if response.get("ok"):
            self.root.after(150, self._finish_close)
        else:
            self.closing = False; self._show_error(response)
            if self.smoke:
                self._cancel_after_jobs(); self.client.terminate(); self.root.destroy()

    def _finish_close(self) -> None:
        self._cancel_after_jobs(); self.client.terminate(); self.root.destroy()


def main() -> int:
    smoke = "--smoke" in sys.argv
    auto_live = "--auto-live" in sys.argv and not smoke
    live_symbol = next((arg.split("=", 1)[1] for arg in sys.argv if arg.startswith("--live-symbol=") and "=" in arg), None)
    auto_live = (auto_live or bool(live_symbol)) and not smoke
    root = tk.Tk()
    try:
        LBankImpulseApp(root, smoke=smoke, auto_live=auto_live, live_symbol=live_symbol)
        root.mainloop()
        return 0
    except Exception as error:
        try: messagebox.showerror("LBank Impulse", str(error))
        except Exception: print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
