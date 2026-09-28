import os

from sqlmodel import Session, select

from main import AdminSecret, ApiKey, create_db, engine, hash_api_key


def bootstrap() -> None:
    key = os.environ.get("ADMIN_BOOTSTRAP_KEY", "").strip()
    if not key:
        raise RuntimeError("ADMIN_BOOTSTRAP_KEY is required")

    create_db()
    with Session(engine) as session:
        admin_secret = session.get(AdminSecret, 1)
        if admin_secret is None:
            session.add(AdminSecret(key_hash=hash_api_key(key)))

        api_key = session.exec(select(ApiKey).where(ApiKey.key_plain == key.upper())).first()
        if api_key is None:
            session.add(
                ApiKey(
                    key_plain=key.upper(),
                    key_hash=hash_api_key(key),
                    label="Administrator",
                    is_admin=True,
                )
            )
        else:
            api_key.is_admin = True
            session.add(api_key)
        session.commit()


if __name__ == "__main__":
    bootstrap()
