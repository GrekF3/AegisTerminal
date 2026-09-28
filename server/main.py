from datetime import datetime, timedelta
from typing import Optional, List

import os
import secrets
from urllib.parse import quote_plus
import uuid

from fastapi import FastAPI, HTTPException, Request, Form, Depends, status, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import jwt
from jwt import PyJWTError as JWTError
import bcrypt
import httpx
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from sqlmodel import SQLModel, Field, Session, create_engine, select
from sqlalchemy import or_
from starlette.responses import PlainTextResponse
from starlette.status import HTTP_303_SEE_OTHER

# ===== Config =====
JWT_SECRET = os.environ.get("JWT_SECRET", "development-only-change-me")
JWT_ALG = "HS256"
ACCESS_TTL_MIN = 60
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./app.db")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() in {"1", "true", "yes"}
ALLOWED_ORIGINS = [origin.strip() for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",") if origin.strip()]
engine = create_engine(
    DATABASE_URL,
    echo=False,
    connect_args={"check_same_thread": False},
)

IP_BAN_THRESHOLD = 3
IP_BAN_DURATION_HOURS = 24
ADMIN_SESSION_TTL_HOURS = 24
ADMIN_SESSION_COOKIE = "keys_admin_session"
SUPPORT_TOKEN_TTL_HOURS = 24
MAX_SUPPORT_LOG_BYTES = 5 * 1024 * 1024

# ===== Rate limit =====
limiter = Limiter(key_func=get_remote_address)

# ===== Templates =====
templates = Jinja2Templates(directory="templates")


# ===== Models =====
class ApiKey(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    key_plain: Optional[str] = Field(default=None, index=True, unique=True)
    key_hash: str
    label: Optional[str] = None
    telegram_id: Optional[str] = Field(default=None, index=True)
    system_fingerprint: Optional[str] = Field(default=None, index=True)
    owner_note: Optional[str] = None
    user_code: Optional[str] = Field(default=None, index=True, unique=True)
    valid_days: Optional[int] = Field(default=None)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    activated_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None
    last_renewed_at: Optional[datetime] = None
    last_used_at: Optional[datetime] = None
    revoked: bool = Field(default=False, index=True)
    is_admin: bool = Field(default=False, index=True)


class IpAccess(SQLModel, table=True):
    ip_address: str = Field(primary_key=True)
    fail_count: int = Field(default=0)
    banned_until: Optional[datetime] = None
    last_attempt_at: Optional[datetime] = None


class AdminSecret(SQLModel, table=True):
    id: int = Field(default=1, primary_key=True)
    key_hash: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


# ===== Helpers =====
def _prepare_secret(value: str) -> bytes:
    data = value.encode('utf-8')
    if len(data) > 72:
        raise ValueError('Secret exceeds bcrypt limit of 72 bytes')
    return data


def hash_api_key(value: str) -> str:
    secret = _prepare_secret(value)
    hashed = bcrypt.hashpw(secret, bcrypt.gensalt())
    return hashed.decode('utf-8')


def verify_api_key(plaintext: str, key_hash: str) -> bool:
    try:
        secret = _prepare_secret(plaintext)
    except ValueError:
        return False
    try:
        return bcrypt.checkpw(secret, key_hash.encode('utf-8'))
    except ValueError:
        return False




def generate_plain_key(length: int = 18) -> str:
    if length <= 0 or length > 32:
        raise ValueError('Key length must be between 1 and 32 characters')
    return uuid.uuid4().hex.upper()[:length]


def generate_unique_plain_key(session: Session, length: int = 18) -> str:
    while True:
        candidate = generate_plain_key(length)
        exists = session.exec(select(ApiKey.id).where(ApiKey.key_plain == candidate)).first()
        if not exists:
            return candidate


def generate_user_code(session: Session) -> str:
    digits = '0123456789'
    while True:
        length = secrets.randbelow(7) + 6  # 6..12
        candidate = ''.join(secrets.choice(digits) for _ in range(length))
        exists = session.exec(select(ApiKey.id).where(ApiKey.user_code == candidate)).first()
        if not exists:
            return candidate


def create_db() -> None:
    SQLModel.metadata.create_all(engine)
    run_migrations()


def run_migrations() -> None:
    table_name = ApiKey.__table__.name
    with engine.begin() as conn:
        exists = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = :name",
            {"name": table_name},
        ).fetchone()
        if not exists:
            return

        rows = conn.exec_driver_sql(f"PRAGMA table_info('{table_name}')").fetchall()
        existing_columns = {row[1] for row in rows}

        def ensure_column(name: str, ddl: str) -> None:
            if name not in existing_columns:
                conn.exec_driver_sql(
                    f'ALTER TABLE "{table_name}" ADD COLUMN "{name}" {ddl}'
                )
                existing_columns.add(name)

        ensure_column("key_plain", "TEXT UNIQUE")
        ensure_column("telegram_id", "TEXT")
        ensure_column("system_fingerprint", "TEXT")
        ensure_column("owner_note", "TEXT")
        ensure_column("user_code", "TEXT UNIQUE")
        ensure_column("activated_at", "DATETIME")
        ensure_column("last_renewed_at", "DATETIME")
        ensure_column("last_used_at", "DATETIME")
        ensure_column("is_admin", "BOOLEAN NOT NULL DEFAULT 0")
        ensure_column("label", "TEXT")
        ensure_column("valid_days", "INTEGER")

        conn.exec_driver_sql(
            f'CREATE UNIQUE INDEX IF NOT EXISTS idx_{table_name}_key_plain ON "{table_name}"(key_plain)'
        )
        conn.exec_driver_sql(
            f'CREATE UNIQUE INDEX IF NOT EXISTS idx_{table_name}_user_code ON "{table_name}"(user_code)'
        )
        conn.exec_driver_sql(
            f'CREATE INDEX IF NOT EXISTS idx_{table_name}_telegram ON "{table_name}"(telegram_id)'
        )
        conn.exec_driver_sql(
            f'CREATE INDEX IF NOT EXISTS idx_{table_name}_revoked ON "{table_name}"(revoked)'
        )


def ensure_admin_secret() -> Optional[str]:
    with Session(engine) as session:
        secret = session.get(AdminSecret, 1)
        if secret:
            return None
        fresh_key = os.environ.get("ADMIN_BOOTSTRAP_KEY") or generate_plain_key()
        session.add(AdminSecret(key_hash=hash_api_key(fresh_key)))
        session.commit()
        return fresh_key


def get_session():
    with Session(engine) as session:
        yield session


def create_admin_token(key_id: Optional[int] = None) -> str:
    payload = {
        "type": "admin",
        "exp": datetime.utcnow() + timedelta(hours=ADMIN_SESSION_TTL_HOURS),
    }
    if key_id is not None:
        payload["key_id"] = key_id
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def create_support_token(key_id: int) -> str:
    return jwt.encode(
        {"type": "support", "key_id": key_id, "exp": datetime.utcnow() + timedelta(hours=SUPPORT_TOKEN_TTL_HOURS)},
        JWT_SECRET,
        algorithm=JWT_ALG,
    )


def is_admin_authenticated(request: Request) -> bool:
    token = request.cookies.get(ADMIN_SESSION_COOKIE)
    if not token:
        return False
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError:
        return False
    return payload.get("type") == "admin"


def require_app_admin(request: Request, session: Session) -> ApiKey:
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin session required")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin session expired")
    if payload.get("type") != "admin" or not payload.get("key_id"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    admin = session.get(ApiKey, int(payload["key_id"]))
    if not admin or not admin.is_admin or admin.revoked:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access revoked")
    return admin


def require_app_user(request: Request, session: Session) -> ApiKey:
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="App session required")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="App session expired")
    if payload.get("type") != "support" or not payload.get("key_id"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="App session required")
    user = session.get(ApiKey, int(payload["key_id"]))
    if not user or user.revoked or (not user.is_admin and user.expires_at and user.expires_at < datetime.utcnow()):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="App access revoked")
    return user


# ===== Schemas =====
class VerifyRequest(BaseModel):
    api_key: str
    telegram_id: Optional[str] = None
    system_fingerprint: Optional[str] = None


class VerifyResponse(BaseModel):
    valid: bool
    key_id: Optional[int] = None
    is_admin: Optional[bool] = None
    expires_at: Optional[datetime] = None
    telegram_id: Optional[str] = None
    user_code: Optional[str] = None
    reason: Optional[str] = None
    banned_until: Optional[datetime] = None
    admin_token: Optional[str] = None
    support_token: Optional[str] = None


class AppAdminCreateRequest(BaseModel):
    name: str
    ttl_days: Optional[int] = None
    note: Optional[str] = None


class AppAdminUpdateRequest(BaseModel):
    name: Optional[str] = None
    note: Optional[str] = None
    revoked: Optional[bool] = None
    reset_device: bool = False
    extend_days: Optional[int] = None


class KeyAdminListItem(BaseModel):
    id: int
    key: str
    telegram_id: Optional[str]
    user_code: Optional[str]
    system_fingerprint: Optional[str]
    label: Optional[str]
    owner_note: Optional[str]
    created_at: datetime
    activated_at: Optional[datetime]
    expires_at: Optional[datetime]
    last_renewed_at: Optional[datetime]
    last_used_at: Optional[datetime]
    is_admin: bool
    revoked: bool
    valid_days: Optional[int]
    remaining_days: Optional[int]
    status: str


def serialize_key(key: ApiKey) -> KeyAdminListItem:
    now = datetime.utcnow()
    remaining_days: Optional[int] = None
    status = "Активен"

    if key.expires_at:
        delta = key.expires_at - now
        remaining_days = max(delta.days, 0)
    elif key.valid_days is not None and not key.activated_at:
        remaining_days = key.valid_days

    if key.revoked:
        status = "Заблокирован"
    elif key.is_admin:
        status = "Админский"
    elif not key.activated_at:
        status = "Ожидает активации" if key.valid_days is not None else "Готов к активации"
    elif key.expires_at:
        status = "Просрочен" if key.expires_at < now else "Активен"

    return KeyAdminListItem(
        id=key.id,
        key=key.key_plain or "<hidden>",
        telegram_id=key.telegram_id,
        user_code=key.user_code,
        system_fingerprint=key.system_fingerprint,
        label=key.label,
        owner_note=key.owner_note,
        created_at=key.created_at,
        activated_at=key.activated_at,
        expires_at=key.expires_at,
        last_renewed_at=key.last_renewed_at,
        last_used_at=key.last_used_at,
        is_admin=key.is_admin,
        revoked=key.revoked,
        valid_days=key.valid_days,
        remaining_days=remaining_days,
        status=status,
    )



# ===== FastAPI app =====
app = FastAPI(title="Keys API")
app.state.limiter = limiter
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["content-type", "authorization"],
)
app.mount("/downloads", StaticFiles(directory=os.environ.get("DOWNLOADS_DIR", "/downloads")), name="downloads")
app.mount("/updates", StaticFiles(directory=os.environ.get("UPDATES_DIR", "/updates")), name="updates")


@app.exception_handler(RateLimitExceeded)
def ratelimit_handler(request: Request, exc: RateLimitExceeded):
    return PlainTextResponse("Too many requests", status_code=status.HTTP_429_TOO_MANY_REQUESTS)


@app.on_event("startup")
def on_startup():
    create_db()
    new_admin_key = ensure_admin_secret()
    if new_admin_key:
        # Never expose bootstrap credentials through HTML or container logs.
        app.state.generated_admin_key = None
    else:
        app.state.generated_admin_key = None


@app.get("/healthz")
def healthcheck():
    return {"status": "ok"}


@app.post("/support/logs")
@limiter.limit("3/hour")
async def upload_support_logs(
    request: Request,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
):
    user = require_app_user(request, session)
    payload = await file.read(MAX_SUPPORT_LOG_BYTES + 1)
    if len(payload) > MAX_SUPPORT_LOG_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="Log file exceeds 5 MB")
    if not payload:
        payload = b'{"level":"info","event":"empty-log"}\n'

    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_LOG_CHAT_ID", "").strip()
    if not bot_token or not chat_id:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Support delivery is not configured")

    caption = "\n".join([
        "Hedge LBank — логи пользователя",
        f"Имя: {user.label or 'Без имени'}",
        f"Ключ: {user.key_plain or '<hidden>'}",
        f"User ID: {user.user_code or 'не назначен'}",
        f"Версия: {request.headers.get('x-app-version', 'unknown')}",
        f"Система: {request.headers.get('x-app-platform', 'unknown')}",
    ])
    safe_name = f"hedge-{user.user_code or user.id}-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.log"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.post(
                f"https://api.telegram.org/bot{bot_token}/sendDocument",
                data={"chat_id": chat_id, "caption": caption},
                files={"document": (safe_name, payload, "text/plain")},
            )
        result = response.json() if response.content else {}
        if response.status_code >= 400 or not result.get("ok"):
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Telegram rejected log delivery")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not deliver logs")
    return {"ok": True}


# ===== Admin HTML =====
@app.get("/admin/login", response_class=HTMLResponse)
def admin_login_form(request: Request):
    generated_key = getattr(app.state, "generated_admin_key", None)
    return templates.TemplateResponse(
        "admin_login.html",
        {
            "request": request,
            "generated_admin_key": generated_key,
            "error": request.query_params.get("error"),
        },
    )


@app.post("/admin/login")
@limiter.limit("5/minute")
def admin_login(
    request: Request,
    admin_key: str = Form(..., description="Super admin key"),
    session: Session = Depends(get_session),
):
    secret = session.get(AdminSecret, 1)
    if not secret or not verify_api_key(admin_key, secret.key_hash):
        redirect = RedirectResponse(
            f"/admin/login?error={quote_plus('Неверный админ-ключ')}",
            status_code=HTTP_303_SEE_OTHER,
        )
        return redirect

    response = RedirectResponse("/admin", status_code=HTTP_303_SEE_OTHER)
    response.set_cookie(
        ADMIN_SESSION_COOKIE,
        create_admin_token(),
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=ADMIN_SESSION_TTL_HOURS * 3600,
    )
    return response


@app.post("/admin/logout")
def admin_logout():
    response = RedirectResponse("/admin/login", status_code=HTTP_303_SEE_OTHER)
    response.delete_cookie(ADMIN_SESSION_COOKIE)
    return response


@app.get("/admin", response_class=HTMLResponse)
def admin_dashboard(request: Request, session: Session = Depends(get_session)):
    if not is_admin_authenticated(request):
        return RedirectResponse("/admin/login", status_code=HTTP_303_SEE_OTHER)

    query_raw = request.query_params.get("q")
    page_param = request.query_params.get("page", "1")
    try:
        page = max(int(page_param), 1)
    except ValueError:
        page = 1
    page_size = 12

    statement = select(ApiKey).order_by(ApiKey.created_at.desc())
    if query_raw:
        term = query_raw.strip().upper()
        like = f"%{term}%"
        statement = statement.where(
            or_(
                ApiKey.key_plain.ilike(like),
                ApiKey.user_code.ilike(like),
            )
        )

    all_keys = session.exec(statement).all()
    total = len(all_keys)
    total_pages = max((total + page_size - 1) // page_size, 1)
    if page > total_pages:
        page = total_pages
    start_idx = (page - 1) * page_size
    end_idx = start_idx + page_size
    page_keys = all_keys[start_idx:end_idx]

    key_items = [serialize_key(k) for k in page_keys]
    now = datetime.utcnow()
    stats = {
        "total": total,
        "active": sum(1 for k in all_keys if not k.revoked and (k.is_admin or (not k.expires_at or k.expires_at >= now))),
        "pending": sum(1 for k in all_keys if not k.revoked and not k.activated_at),
        "admins": sum(1 for k in all_keys if k.is_admin),
        "revoked": sum(1 for k in all_keys if k.revoked),
    }

    qs_parts = []
    if query_raw:
        qs_parts.append(("q", query_raw))
    if page > 1:
        qs_parts.append(("page", page))
    query_string = ""
    if qs_parts:
        query_string = "?" + "&".join(f"{name}={quote_plus(str(value))}" for name, value in qs_parts)

    pagination = {
        "page": page,
        "pages": total_pages,
        "has_prev": page > 1,
        "has_next": page < total_pages,
        "query": query_raw.strip() if query_raw else "",
        "query_string": query_string,
    }

    message = request.query_params.get("message")
    generated_key = getattr(app.state, "generated_admin_key", None)
    new_keys = getattr(app.state, "last_created_keys", [])
    app.state.last_created_keys = []
    return templates.TemplateResponse(
        "admin_dashboard.html",
        {
            "request": request,
            "keys": key_items,
            "stats": stats,
            "message": message,
            "generated_admin_key": generated_key,
            "new_keys": new_keys,
            "pagination": pagination,
        },
    )



def redirect_with_message(message: str, request: Optional[Request] = None) -> RedirectResponse:
    params = []
    if request:
        q = request.query_params.get("q")
        if q:
            params.append(("q", q))
        page = request.query_params.get("page")
        if page:
            params.append(("page", page))
    params.append(("message", message))
    query_str = "&".join(f"{key}={quote_plus(str(value))}" for key, value in params if value is not None)
    return RedirectResponse(
        f"/admin?{query_str}",
        status_code=HTTP_303_SEE_OTHER,
    )


def require_admin_html(request: Request) -> Optional[RedirectResponse]:
    if not is_admin_authenticated(request):
        return RedirectResponse("/admin/login", status_code=HTTP_303_SEE_OTHER)
    return None


@app.post("/admin/keys/create")
def admin_create_keys(
    request: Request,
    count: int = Form(1),
    ttl_days: Optional[int] = Form(None),
    label: Optional[str] = Form(None),
    owner_note: Optional[str] = Form(None),
    is_admin: bool = Form(False),
    session: Session = Depends(get_session),
):
    guard = require_admin_html(request)
    if guard:
        return guard

    if count < 1 or count > 100:
        return redirect_with_message("Количество ключей от 1 до 100", request)

    if ttl_days is not None and ttl_days <= 0:
        return redirect_with_message("Срок действия должен быть больше 0", request)

    if is_admin and ttl_days:
        return redirect_with_message("Админский ключ не может иметь срок действия", request)

    created_keys: List[str] = []
    for _ in range(count):
        raw_key = generate_unique_plain_key(session)
        key_obj = ApiKey(
            key_plain=raw_key,
            key_hash=hash_api_key(raw_key),
            label=label,
            owner_note=owner_note,
            valid_days=ttl_days if (not is_admin and ttl_days) else None,
            expires_at=None,
            last_renewed_at=None,
            is_admin=bool(is_admin),
        )
        session.add(key_obj)
        created_keys.append(raw_key)
    session.commit()

    request.app.state.last_created_keys = created_keys
    message = f"Создано ключей: {len(created_keys)}"
    return redirect_with_message(message, request)


@app.post("/admin/keys/{key_id}/extend")
def admin_extend_key(
    key_id: int,
    request: Request,
    days: int = Form(...),
    session: Session = Depends(get_session),
):
    guard = require_admin_html(request)
    if guard:
        return guard

    if days <= 0:
        return redirect_with_message("Количество дней должно быть > 0", request)

    key = session.get(ApiKey, key_id)
    if not key:
        return redirect_with_message("Ключ не найден", request)
    if key.is_admin:
        return redirect_with_message("Админский ключ не истекает", request)

    now = datetime.utcnow()
    if not key.activated_at:
        key.valid_days = (key.valid_days or 0) + days
    else:
        base = key.expires_at if key.expires_at and key.expires_at > now else now
        key.expires_at = base + timedelta(days=days)
    key.last_renewed_at = now
    session.add(key)
    session.commit()
    return redirect_with_message("Срок действия продлен", request)


@app.post("/admin/keys/{key_id}/ban")
def admin_ban_key(key_id: int, request: Request, session: Session = Depends(get_session)):
    guard = require_admin_html(request)
    if guard:
        return guard

    key = session.get(ApiKey, key_id)
    if not key:
        return redirect_with_message("Ключ не найден", request)
    key.revoked = True
    session.add(key)
    session.commit()
    return redirect_with_message("Ключ заблокирован", request)


@app.post("/admin/keys/{key_id}/unban")
def admin_unban_key(key_id: int, request: Request, session: Session = Depends(get_session)):
    guard = require_admin_html(request)
    if guard:
        return guard

    key = session.get(ApiKey, key_id)
    if not key:
        return redirect_with_message("Ключ не найден", request)
    key.revoked = False
    session.add(key)
    session.commit()
    return redirect_with_message("Ключ разблокирован", request)


@app.post("/admin/keys/{key_id}/make-admin")
def admin_make_key_admin(key_id: int, request: Request, session: Session = Depends(get_session)):
    guard = require_admin_html(request)
    if guard:
        return guard

    key = session.get(ApiKey, key_id)
    if not key:
        return redirect_with_message("Ключ не найден", request)
    key.is_admin = True
    key.valid_days = None
    key.expires_at = None
    key.last_renewed_at = None
    key.revoked = False
    session.add(key)
    session.commit()
    return redirect_with_message("Назначен админский ключ", request)


@app.post("/admin/keys/{key_id}/update")
def admin_update_key(
    key_id: int,
    request: Request,
    telegram_id: Optional[str] = Form(None),
    system_fingerprint: Optional[str] = Form(None),
    label: Optional[str] = Form(None),
    owner_note: Optional[str] = Form(None),
    reset_activation: bool = Form(False),
    session: Session = Depends(get_session),
):
    guard = require_admin_html(request)
    if guard:
        return guard

    key = session.get(ApiKey, key_id)
    if not key:
        return redirect_with_message("Ключ не найден", request)

    key.telegram_id = telegram_id or None
    key.system_fingerprint = system_fingerprint or None
    key.label = label or None
    key.owner_note = owner_note or None
    if reset_activation:
        key.activated_at = None
        key.last_used_at = None
        key.user_code = None
        key.expires_at = None
    session.add(key)
    session.commit()
    return redirect_with_message("Данные обновлены", request)


# ===== Desktop admin API =====
@app.get("/app-admin/users")
def app_admin_users(request: Request, session: Session = Depends(get_session)):
    require_app_admin(request, session)
    users = session.exec(select(ApiKey).order_by(ApiKey.created_at.desc())).all()
    return {"users": [serialize_key(item).model_dump(mode="json") for item in users if not item.is_admin]}


@app.get("/app-admin/users/{key_id}")
def app_admin_user(key_id: int, request: Request, session: Session = Depends(get_session)):
    require_app_admin(request, session)
    item = session.get(ApiKey, key_id)
    if not item or item.is_admin:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return {"user": serialize_key(item).model_dump(mode="json")}


@app.post("/app-admin/users")
def app_admin_create_user(payload: AppAdminCreateRequest, request: Request, session: Session = Depends(get_session)):
    require_app_admin(request, session)
    name = payload.name.strip()
    if not name or len(name) > 80:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Name must contain 1-80 characters")
    if payload.ttl_days is not None and (payload.ttl_days < 1 or payload.ttl_days > 3650):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="TTL must be between 1 and 3650 days")
    raw_key = generate_unique_plain_key(session)
    item = ApiKey(
        key_plain=raw_key,
        key_hash=hash_api_key(raw_key),
        label=name,
        owner_note=(payload.note or "").strip() or None,
        valid_days=payload.ttl_days,
    )
    session.add(item)
    session.commit()
    session.refresh(item)
    return {"user": serialize_key(item).model_dump(mode="json")}


@app.post("/app-admin/users/{key_id}")
def app_admin_update_user(key_id: int, payload: AppAdminUpdateRequest, request: Request, session: Session = Depends(get_session)):
    require_app_admin(request, session)
    item = session.get(ApiKey, key_id)
    if not item or item.is_admin:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if payload.name is not None:
        name = payload.name.strip()
        if not name or len(name) > 80:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Name must contain 1-80 characters")
        item.label = name
    if payload.note is not None:
        item.owner_note = payload.note.strip() or None
    if payload.revoked is not None:
        item.revoked = payload.revoked
    if payload.reset_device:
        item.system_fingerprint = None
    if payload.extend_days is not None:
        if payload.extend_days < 1 or payload.extend_days > 3650:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Extension must be between 1 and 3650 days")
        now = datetime.utcnow()
        if item.activated_at:
            item.expires_at = max(item.expires_at or now, now) + timedelta(days=payload.extend_days)
        else:
            item.valid_days = (item.valid_days or 0) + payload.extend_days
        item.last_renewed_at = now
    session.add(item)
    session.commit()
    session.refresh(item)
    return {"user": serialize_key(item).model_dump(mode="json")}


# ===== Verify endpoint =====
@app.post("/verify", response_model=VerifyResponse)
@limiter.limit("10/minute")
def verify_key(
    req: VerifyRequest,
    request: Request,
    session: Session = Depends(get_session),
):
    now = datetime.utcnow()
    client_ip = request.client.host if request.client else "unknown"

    ip_record = session.get(IpAccess, client_ip)
    if ip_record and ip_record.banned_until and ip_record.banned_until > now:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"IP banned until {ip_record.banned_until.isoformat()}",
        )

    submitted_key = (req.api_key or "").strip()
    normalized_key = submitted_key.upper()

    key = None
    if normalized_key:
        key = session.exec(select(ApiKey).where(ApiKey.key_plain == normalized_key)).first()

    if not key and submitted_key:
        # fallback для старых ключей
        candidates = session.exec(select(ApiKey).where(ApiKey.revoked == False)).all()
        for candidate in candidates:
            if verify_api_key(submitted_key, candidate.key_hash):
                key = candidate
                key.key_plain = normalized_key or submitted_key
                break

    def register_failure() -> VerifyResponse:
        record = session.get(IpAccess, client_ip) or IpAccess(ip_address=client_ip)
        record.fail_count = (record.fail_count or 0) + 1
        record.last_attempt_at = now
        if record.fail_count >= IP_BAN_THRESHOLD:
            record.banned_until = now + timedelta(hours=IP_BAN_DURATION_HOURS)
            record.fail_count = IP_BAN_THRESHOLD
        session.add(record)
        session.commit()
        session.refresh(record)
        return VerifyResponse(valid=False, reason="invalid_key", banned_until=record.banned_until)

    if not key:
        return register_failure()

    if key.revoked:
        response = register_failure()
        response.reason = "banned_key"
        return response

    if key.valid_days is not None and key.activated_at and not key.expires_at:
        key.expires_at = key.activated_at + timedelta(days=key.valid_days)
        session.add(key)

    if not key.is_admin and key.expires_at and key.expires_at < now:
        response = register_failure()
        response.reason = "expired"
        response.expires_at = key.expires_at
        return response

    if key.system_fingerprint:
        if req.system_fingerprint is None:
            response = register_failure()
            response.reason = "system_required"
            return response
        if req.system_fingerprint != key.system_fingerprint:
            response = register_failure()
            response.reason = "system_mismatch"
            return response
    elif req.system_fingerprint:
        key.system_fingerprint = req.system_fingerprint

    if key.telegram_id:
        if req.telegram_id and req.telegram_id != key.telegram_id:
            response = register_failure()
            response.reason = "telegram_mismatch"
            return response
    elif req.telegram_id:
        key.telegram_id = req.telegram_id

    record = session.get(IpAccess, client_ip)
    if record and (record.fail_count or record.banned_until):
        record.fail_count = 0
        record.banned_until = None
        record.last_attempt_at = now
        session.add(record)

    if not key.activated_at:
        key.activated_at = now
        if not key.user_code:
            key.user_code = generate_user_code(session)
        if key.valid_days is not None:
            key.expires_at = now + timedelta(days=key.valid_days)
            key.last_renewed_at = now
    else:
        if not key.user_code:
            key.user_code = generate_user_code(session)
        if key.valid_days is not None and not key.expires_at:
            key.expires_at = key.activated_at + timedelta(days=key.valid_days)

    key.last_used_at = now
    session.add(key)
    session.commit()
    session.refresh(key)

    return VerifyResponse(
        valid=True,
        key_id=key.id,
        is_admin=key.is_admin,
        expires_at=key.expires_at,
        telegram_id=key.telegram_id,
        user_code=key.user_code,
        admin_token=create_admin_token(key.id) if key.is_admin else None,
        support_token=create_support_token(key.id),
    )
