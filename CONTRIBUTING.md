# Как помочь проекту

Для начала установите Node.js 22, Rust stable и зависимости Tauri для своей ОС.
Подробная настройка есть в [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

```bash
npm ci
npm run dev:desktop
```

Перед pull request запустите:

```bash
npm run check
cargo fmt --manifest-path core/Cargo.toml --check
cargo test --manifest-path core/Cargo.toml --locked
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Несколько простых правил:

- не добавляйте токены, ключи, `.env`, логи и личные данные;
- для исправления ошибки по возможности добавляйте тест;
- не коммитьте `dist`, `target` и другие результаты сборки;
- для новой зависимости укажите её лицензию и обновите отчёты из
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md);
- большие изменения лучше сначала обсудить в issue.

В pull request напишите, что изменилось, как это проверялось и на какой ОС.
Уязвимости нужно отправлять по инструкции из [SECURITY.md](SECURITY.md), а не в
открытый issue.

Отправляя код в проект, вы разрешаете распространять его под
`GPL-3.0-only`. Авторские права на ваш код остаются у вас.
