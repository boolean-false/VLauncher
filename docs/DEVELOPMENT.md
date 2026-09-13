# Разработка

Нужны Git, Node.js 22, Rust stable и зависимости Tauri для вашей ОС. На Windows
используйте PowerShell, а не WSL. Список системных пакетов есть в
[документации Tauri](https://v2.tauri.app/start/prerequisites/).

На Windows нужен Rust с MSVC:

```powershell
rustup toolchain install stable-x86_64-pc-windows-msvc
rustup override set stable-x86_64-pc-windows-msvc
```

На macOS установите Xcode Command Line Tools. На Apple Silicon Node и Rust тоже
должны быть ARM-версиями. На Linux нужны WebKitGTK 4.1 и остальные библиотеки
Tauri.

## Запуск и проверка

```bash
npm ci
npm run dev:desktop
```

React обновляется без перезапуска. После изменения Rust приложение
пересобирается и открывается заново. Не запускайте две копии dev-сервера: обе
попытаются занять порт 1420.

Основные проверки:

```bash
npm run check
cargo test --manifest-path core/Cargo.toml --locked
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm run tauri -- build --no-bundle
```

Сборка на Linux не проверяет Windows и macOS, поэтому для них используется
матрица CI и ручная проверка.

## Windows без ключа обновлений

```powershell
npm ci
npm run build:windows
```

Установщик появится в `src-tauri/target/release/bundle/nsis`. Такая сборка не
подписана ключом обновлений и сертификатом издателя. Для запуска на другом
компьютере нужен WebView2 Runtime.

Windows использует Origin `https://tauri.localhost`. Для Linux и macOS Origin -
`tauri://localhost`. Оба адреса должны быть разрешены на сервере.

## Где искать код

| Что | Файлы |
| --- | --- |
| Интерфейс | `src/components`, `src/desktop.ts` |
| Команды Tauri и запуск игры | `src-tauri/src/lib.rs` |
| Discord | `src-tauri/src/presence.rs`, `presence_ipc.rs` |
| Установка VoxelCore | `core/src/official.rs` |
| Профили и миры | `core/src/profile.rs` |
| Окно и разрешения | `src-tauri/tauri.conf.json`, `src-tauri/capabilities` |

Общую работу с файлами и пакетами лучше держать в `core`. Код, зависящий от ОС,
ограждается через `cfg` или выносится в отдельный модуль.

## Что проверить вручную

На Windows и macOS проверьте запуск и остановку игры, пути с пробелами и
кириллицей, файловые диалоги, сохранение входа, меню, буфер обмена, Discord и
масштаб окна. На Linux дополнительно проверьте Wayland и X11.

Не копируйте `node_modules`, `target` и `dist` между разными ОС. Файлы
`.env`, ключи подписи и логи тоже не нужно добавлять в Git.

Адрес реестра задаётся через `VITE_REGISTRY_URL` и
`VLAUNCHER_REGISTRY_URL`. Значения должны совпадать. При смене сервера
потребуется войти заново.
