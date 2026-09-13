# Лицензии сторонних компонентов

Код VLauncher распространяется под `GPL-3.0-only`. У сторонних библиотек и
шрифта остаются их собственные лицензии.

## JetBrains Mono

Файл `public/fonts/workbench-mono.woff` - JetBrains Mono Regular, Copyright
2020 The JetBrains Mono Project Authors. Шрифт используется по SIL Open Font
License 1.1. Текст лицензии лежит в
[`public/fonts/JetBrainsMono-LICENSE.txt`](public/fonts/JetBrainsMono-LICENSE.txt).

## Зависимости

Точные версии записаны в `package-lock.json`, `core/Cargo.lock` и
`src-tauri/Cargo.lock`. Полные тексты лицензий собраны в:

- [`NPM_THIRD_PARTY_LICENSES.html`](NPM_THIRD_PARTY_LICENSES.html);
- [`RUST_THIRD_PARTY_LICENSES.html`](RUST_THIRD_PARTY_LICENSES.html).

Эти файлы также добавляются в готовые пакеты VLauncher. После изменения
зависимостей их нужно пересобрать:

```bash
npm run licenses:npm
cargo install --locked --features cli --version 0.9.1 cargo-about
npm run licenses:rust
```

GTK, WebKitGTK и другие системные библиотеки Linux устанавливаются системой или
попадают в AppImage со своими лицензиями.
