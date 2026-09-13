# Discord Rich Presence

VLauncher подключается к запущенному Discord через локальный IPC. Токен бота и
вход через Discord не нужны.

Application ID проекта: `1249301455035437150`. По умолчанию он читается из
`src-tauri/discord-application-id.txt`. Для теста с другим приложением:

```bash
VLAUNCHER_DISCORD_APPLICATION_ID=YOUR_APPLICATION_ID npm run dev:desktop
```

Discord показывает два состояния: пользователь находится в лаунчере или играет
в VoxelCore. Имена профилей и миров не передаются. Интеграцию можно выключить в
настройках.

Если Discord не запущен, приложение пробует подключиться снова через 15 секунд.
На Linux поддерживаются обычный Discord, Flatpak и Vesktop. Сервер VSpace здесь
не используется.
