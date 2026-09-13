# Иконка VLauncher

Исходник иконки - `icon.svg`. В нём нет шрифтов и внешних файлов. Основные
цвета: `#44484B` и `#E8E7E0`.

После изменения SVG запустите:

```bash
npm run icons
```

Команда обновит PNG, ICO, ICNS и `public/vlauncher.png`. Сгенерированные файлы
нужно коммитить вместе с SVG.

Картинки установщика Windows создаёт
`scripts/generate-installer-artwork.ps1`. Размеры BMP менять нельзя, их задаёт
NSIS. Цвета установщика находятся в
`src-tauri/windows/installer-hooks.nsh`.
