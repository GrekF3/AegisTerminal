import unittest
import tkinter as tk
import tempfile
from pathlib import Path

from lbank_impulse import LBankImpulseApp, SPACE_SM, decision_text, fmt_bps, fmt_money, fmt_price, phase_text


class DummyClient:
    def __init__(self, _on_message):
        self.requests = []

    def poll(self):
        pass

    def request(self, command, params, callback):
        self.requests.append((command, params, callback))
        return "test"

    def terminate(self):
        pass


class FormattingTests(unittest.TestCase):
    def test_market_values_are_compact_and_safe(self):
        self.assertEqual(fmt_price(None), "n/a")
        self.assertEqual(fmt_price(0.0012300), "0.00123")
        self.assertEqual(fmt_money(-12.5), "−$12.50")
        self.assertEqual(fmt_bps(4.123), "+4.12 bps")

    def test_known_phases_are_localized(self):
        self.assertEqual(phase_text("warming_up"), "Ожидание первых котировок")
        self.assertEqual(phase_text("recovery"), "Требуется сверка")
        self.assertEqual(decision_text("lag_not_positive"), "Нет лага в сторону сигнала")
        self.assertEqual(decision_text("edge_too_small"), "Edge не покрывает расходы")
        self.assertEqual(decision_text(None, True), "ВХОД РАЗРЕШЁН")


class LayoutTests(unittest.TestCase):
    def test_ui_journal_is_persisted_and_restored(self):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f"Tk is unavailable: {error}")
        with tempfile.TemporaryDirectory() as directory:
            log_path = Path(directory) / "logs" / "ui.log"
            app = LBankImpulseApp(root, client_factory=DummyClient, log_path=log_path)
            try:
                app._append_log("Проверка постоянного журнала", "error")
                self.assertIn("[ERROR]  Проверка постоянного журнала", log_path.read_text(encoding="utf-8"))
                app.log.configure(state="normal"); app.log.delete("1.0", "end"); app.log.configure(state="disabled")
                app._load_saved_logs()
                self.assertIn("Проверка постоянного журнала", app.log.get("1.0", "end-1c"))
            finally:
                app._cancel_after_jobs(); app.client.terminate(); root.destroy()

    def test_minimum_window_keeps_panels_separate_and_stop_visible(self):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f"Tk is unavailable: {error}")
        app = LBankImpulseApp(root, client_factory=DummyClient, persist_logs=False)
        try:
            root.geometry("1180x760+0+0")
            root.update()
            root_x, root_y = root.winfo_rootx(), root.winfo_rooty()
            width, height = root.winfo_width(), root.winfo_height()
            for widget in [app.setup_panel, app.status_panel, app.venues_panel, app.lower_panel, app.info_panel, app.analyzer_panel,
                           app.analyzer_tree, app.start_button, app.auto_start_button, app.pause_button, app.flatten_button]:
                left, top = widget.winfo_rootx() - root_x, widget.winfo_rooty() - root_y
                self.assertGreater(widget.winfo_width(), 0)
                self.assertGreater(widget.winfo_height(), 0)
                self.assertGreaterEqual(left, 0)
                self.assertGreaterEqual(top, 0)
                self.assertLessEqual(left + widget.winfo_width(), width)
                self.assertLessEqual(top + widget.winfo_height(), height)
            gap = app.analyzer_panel.winfo_rootx() - (app.info_panel.winfo_rootx() + app.info_panel.winfo_width())
            self.assertGreaterEqual(gap, SPACE_SM)
            self.assertLessEqual(app.lower_panel.winfo_rooty() + app.lower_panel.winfo_height(), app.log_panel.winfo_rooty())
            app._apply_state({"phase": "waiting", "running": True, "sessionTrades": 4, "sessionWins": 3, "sessionLosses": 1,
                              "sessionBreakeven": 0, "realizedGross": 2, "feesPaid": .5, "realizedNet": 1.5})
            self.assertEqual(app.signal_values["trades"].cget("text"), "4 · 3/1/0 · 75% WR")
            self.assertEqual(app.signal_values["session"].cget("text"), "$2.00 / $0.50 / $1.50")
            app._apply_analyzer({"running": True, "universe": {"lbank": 836, "lbankBinance": 433, "lbankMexc": 563},
                                 "totals": {"symbols": 572, "trades": 8, "net": .42, "liveReady": 1},
                                 "rows": [{"symbol": "BTCUSDT", "leader": "binance", "thresholdBps": 3, "priority": 12,
                                           "eligibleForLive": True, "adaptiveTrades": 8, "adaptiveWinRate": .625,
                                           "adaptiveFillRate": .75, "adaptiveNet": .42, "dailyLosses": 1, "capStreak": 0, "lagMs": 120}]})
            self.assertEqual(len(app.analyzer_tree.get_children()), 1)
            analyzer_row = app.analyzer_tree.get_children()[0]; app.analyzer_tree.selection_set(analyzer_row); app._show_analyzer_detail()
            self.assertIn("BTCUSDT", app.candidate_detail.cget("text")); self.assertIn("losses сегодня 1/5", app.candidate_detail.cget("text"))
            for index in range(80):
                app._append_log(f"Строка {index}")
            root.update(); app.log.yview_moveto(.2); app.log.tag_add("sel", "10.0", "10.6"); root.update()
            before = app.log.yview(); selected = app.log.get("sel.first", "sel.last")
            app._append_log("Новая строка без принудительной прокрутки"); root.update()
            self.assertAlmostEqual(app.log.yview()[0], before[0], places=2)
            self.assertEqual(app.log.get("sel.first", "sel.last"), selected)
            app.log.tag_remove("sel", "1.0", "end"); app._jump_logs_to_end(); app._append_log("Новая строка в follow-tail"); root.update()
            self.assertAlmostEqual(app.log.yview()[1], 1.0, places=3)
            app._copy_logs(); self.assertIn("Новая строка в follow-tail", root.clipboard_get())
        finally:
            app._cancel_after_jobs()
            app.client.terminate()
            root.destroy()

    def test_flatten_invalidates_a_pending_configure_to_start_chain(self):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f"Tk is unavailable: {error}")
        app = LBankImpulseApp(root, client_factory=DummyClient, persist_logs=False)
        try:
            root.geometry("1180x760+0+0")
            root.update()
            app._start()
            command, params, saved = app.client.requests[-1]
            self.assertEqual(command, "save_settings")
            self.assertNotIn("leverage", params)
            saved({"ok": True, "result": {"settings": app._effective_for_symbol(), "settingsProfile": app._settings_profile()}})
            command, config_params, configured = app.client.requests[-1]
            self.assertEqual(command, "configure")
            self.assertEqual(config_params["leverage"], 5)
            self.assertEqual(config_params["minimumHoldMs"], 2000)
            self.assertEqual(config_params["maxLossPercent"], 1)
            app._flatten()
            configured({"ok": True, "result": {}})
            self.assertNotIn("start", [row[0] for row in app.client.requests])
            self.assertEqual(app.client.requests[-1][0], "flatten")
        finally:
            app._cancel_after_jobs()
            app.client.terminate()
            root.destroy()

    def test_auto_live_flag_connects_saved_profile_and_starts_portfolio(self):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f"Tk is unavailable: {error}")
        app = LBankImpulseApp(root, client_factory=DummyClient, persist_logs=False, auto_live=True)
        try:
            app.state = {"settings": {"profileId": "profile_1"}}
            app._profiles_result({"ok": True, "result": [{"id": "profile_1", "name": "Trading", "status": "started"}]})
            root.update()
            self.assertEqual(app.mode_var.get(), "Live")
            self.assertEqual(app.client.requests[-1][0], "save_settings")
            saved = app.client.requests[-1][2]
            saved({"ok": True, "result": {}})
            self.assertEqual(app.client.requests[-1][0], "connect")
            connected = app.client.requests[-1][2]
            connected({"ok": True, "result": {}})
            self.assertEqual([row[0] for row in app.client.requests[-2:]], ["symbols", "portfolio_start"])
        finally:
            app._cancel_after_jobs(); app.client.terminate(); root.destroy()

    def test_auto_live_recovery_connects_without_trying_to_overwrite_locked_settings(self):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f"Tk is unavailable: {error}")
        app = LBankImpulseApp(root, client_factory=DummyClient, persist_logs=False, auto_live=True)
        try:
            app.state = {"settings": {"profileId": "profile_1"}, "recovery": {"activeOrder": {"orderId": "entry-1"}}}
            app._profiles_result({"ok": True, "result": [{"id": "profile_1", "name": "Trading", "status": "started"}]})
            self.assertEqual(app.client.requests[-1][0], "connect")
            self.assertNotIn("save_settings", [row[0] for row in app.client.requests])
        finally:
            app._cancel_after_jobs(); app.client.terminate(); root.destroy()

    def test_live_symbol_uses_automatic_risk_sizing_before_start(self):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f"Tk is unavailable: {error}")
        app = LBankImpulseApp(root, client_factory=DummyClient, persist_logs=False, auto_live=True, live_symbol="power_usdt")
        try:
            app.state = {"settings": {"profileId": "profile_1"}}
            app._profiles_result({"ok": True, "result": [{"id": "profile_1", "name": "Trading", "status": "started"}]})
            root.update(); app.client.requests[-1][2]({"ok": True, "result": {}})
            app.client.requests[-1][2]({"ok": True, "result": {}})
            command, params, configured = app.client.requests[-1]
            self.assertEqual(command, "configure"); self.assertEqual(params["symbol"], "POWERUSDT")
            self.assertTrue(params["autoPosition"]); self.assertEqual(params["maxLossPercent"], 1)
            configured({"ok": True, "result": {}})
            self.assertEqual(app.client.requests[-1][0], "start")
        finally:
            app._cancel_after_jobs(); app.client.terminate(); root.destroy()

    def test_symbol_search_and_draft_keep_user_values(self):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f"Tk is unavailable: {error}")
        app = LBankImpulseApp(root, client_factory=DummyClient, persist_logs=False)
        try:
            app.symbols = ["BTCUSDT", "BTCDOMUSDT", "ETHUSDT", "SOLUSDT"]
            app.symbol_var.set("btc"); app._filter_symbols()
            self.assertEqual(list(app.symbol_combo.cget("values")), ["BTCUSDT", "BTCDOMUSDT"])
            app.form_ready = True; app._bind_form()
            app.setting_vars["nominal"].set("75,5"); app.setting_vars["leverage"].set("17"); app.setting_vars["impulsePercent"].set("0,006"); app.setting_vars["cooldownSeconds"].set("42")
            values = app._read_strategy_settings(False)
            self.assertEqual({key: values[key] for key in ["nominal", "leverage", "impulsePercent", "cooldownSeconds"]},
                             {"nominal": 75.5, "leverage": 17, "impulsePercent": 0.006, "cooldownSeconds": 42})
            app.form_dirty = True
            stale = {"phase": "connected", "running": False, "settings": {**app._effective_for_symbol(), "symbol": "ETHUSDT", "nominal": 10,
                      "leverage": 5, "impulsePercent": 0.04, "cooldownSeconds": 180, "mode": "paper", "paperFast": True}}
            app._apply_state(stale)
            self.assertEqual(app.symbol_var.get(), "btc"); self.assertEqual(app.setting_vars["leverage"].get(), "17")
            app._apply_state(stale, force_settings=True)
            self.assertEqual(app.symbol_var.get(), "ETHUSDT"); self.assertEqual(app.setting_vars["leverage"].get(), "5"); self.assertEqual(app.setting_vars["impulsePercent"].get(), "0.04"); self.assertEqual(app.mode_var.get(), "Paper Test")
            self.assertEqual(app.setting_vars["maxLossPercent"].get(), "1")
        finally:
            app._cancel_after_jobs()
            app.client.terminate()
            root.destroy()

    def test_separate_settings_window_supports_global_and_symbol_overrides(self):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f"Tk is unavailable: {error}")
        app = LBankImpulseApp(root, client_factory=DummyClient, persist_logs=False)
        try:
            base = app._settings_profile()["global"]
            app._apply_state({"phase": "connected", "running": False, "settings": {**base, "symbol": "ZECUSDT", "mode": "paper", "paperFast": False},
                              "settingsProfile": {"version": 2, "profileId": "p1", "mode": "paper", "paperFast": False, "lastSymbol": "ZECUSDT",
                                                  "global": base, "symbols": {"ZECUSDT": {"impulsePercent": .03, "minimumHoldMs": 1500}}}}, force_settings=True)
            app._open_settings(); app.settings_window.geometry("800x680+0+0"); root.update()
            window = app.settings_window; self.assertIsNotNone(window)
            self.assertGreaterEqual(window.winfo_width(), 800); self.assertGreaterEqual(window.winfo_height(), 680)
            window_x, window_y = window.winfo_rootx(), window.winfo_rooty()
            for widget in [*app.settings_entries.values(), app.settings_save_button, app.settings_reset_button]:
                left, top = widget.winfo_rootx() - window_x, widget.winfo_rooty() - window_y
                self.assertGreater(widget.winfo_width(), 0); self.assertGreater(widget.winfo_height(), 0)
                self.assertGreaterEqual(left, 0); self.assertGreaterEqual(top, 0)
                self.assertLessEqual(left + widget.winfo_width(), window.winfo_width())
                self.assertLessEqual(top + widget.winfo_height(), window.winfo_height())
            app.settings_scope_var.set("symbol"); app._load_settings_scope()
            self.assertTrue(app.override_vars["impulsePercent"].get()); self.assertEqual(app.setting_vars["impulsePercent"].get(), "0.03")
            self.assertFalse(app.override_vars["reversalPercent"].get())
            app.override_vars["reversalPercent"].set(True); app.setting_vars["reversalPercent"].set("0.04"); app._save_settings_dialog()
            command, params, callback = app.client.requests[-1]
            self.assertEqual(command, "save_settings"); self.assertEqual(params["settingsSymbol"], "ZECUSDT")
            self.assertEqual(params["symbolSettings"], {"impulsePercent": .03, "minimumHoldMs": 1500, "reversalPercent": .04})
            callback({"ok": True, "result": {"settings": app.state["settings"], "settingsProfile": app.state["settingsProfile"]}})
        finally:
            app._close_settings_window(); app._cancel_after_jobs(); app.client.terminate(); root.destroy()


if __name__ == "__main__":
    unittest.main()
