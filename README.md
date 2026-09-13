# VLauncher

Лаунчер для VoxelCore. Интерфейс сделан на React, само приложение - на Tauri и
Rust. Здесь лежит только клиент, сервер VSpace находится в другом проекте.

Готовые сборки и обновления выходят на [vlauncher.space](https://vlauncher.space).
Сборка из исходников будет работать, но автоматические обновления DaggerLab у неё
не подписаны.

## Запуск проекта

Понадобятся Node.js 22, Rust stable и системные библиотеки из
[инструкции Tauri](https://v2.tauri.app/start/prerequisites/).

```bash
npm ci
npm run dev:desktop
```

Эта команда запускает окно приложения и следит за изменениями React и Rust.
Обычный `npm run dev` запускает только интерфейс в браузере, без команд Tauri.

Проверки перед отправкой изменений:

```bash
npm run check
cargo fmt --manifest-path core/Cargo.toml --check
cargo test --manifest-path core/Cargo.toml --locked
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo check --manifest-path src-tauri/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Собрать приложение без установщика:

```bash
npm run tauri -- build --no-bundle
```

Больше информации по разным ОС есть в [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Как это устроено

- `src` - интерфейс;
- `src-tauri` - окно приложения, системные меню, хранение токенов и запуск игры;
- `core` - установка пакетов, профили, миры и работа с файлами;
- `scripts` - сборка установщиков и выпуск обновлений.

Официальные версии VoxelCore берутся из GitHub Releases проекта
`MihailRis/voxelcore`. Перед установкой лаунчер проверяет платформу, размер, хеш и
подпись, если она есть. Пакеты из VSpace устанавливаются только после проверки
подписанного ответа сервера.

Профили и миры лежат отдельно. Обновление контента не должно затирать миры,
настройки и добавленные вручную файлы. Профиль можно экспортировать в
`.vlauncher.json`, а затем восстановить на другом компьютере.

Экспериментальные сборки ветки `main` описаны в
[docs/MAINLINE.md](docs/MAINLINE.md). Для них нужен отдельный вход в GitHub.

## Настройки для разработки

Адрес реестра задаётся при сборке. В репозитории указан нерабочий пример, поэтому
для локального запуска нужно передать адрес своего сервера и ключ проверки:

```bash
VITE_REGISTRY_URL=https://example.test/api/v1 \
VLAUNCHER_REGISTRY_URL=https://example.test/api/v1 \
VLAUNCHER_TRUSTED_SIGNING_PUBLIC_KEYS=<public-key> npm run dev:desktop
```

Токен VSpace сначала сохраняется в Secret Service на Linux, Credential Manager
на Windows или Keychain на macOS. Если это хранилище недоступно, используется
файл в папке настроек приложения. На Unix он создаётся с правами `0600`.
GitHub-токен для сборок main без системного хранилища остаётся только в памяти.

Закрытый ключ обновлений в репозиторий добавлять нельзя.

## Документы

- [Как помочь проекту](CONTRIBUTING.md)
- [Поддержка](SUPPORT.md)
- [Безопасность](SECURITY.md)
- [Приватность](PRIVACY.md)

## Лицензия

Код распространяется по [GNU GPLv3](LICENSE), только версия 3
(`GPL-3.0-only`). При распространении изменённой сборки нужно также предоставить
её исходный код под GPLv3.

У зависимостей и шрифта свои лицензии, они перечислены в
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Название и логотип VLauncher не
входят в лицензию на код, подробности есть в [TRADEMARKS.md](TRADEMARKS.md).
