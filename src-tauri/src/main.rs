// Не открывать консоль рядом с окном приложения.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vlauncher_lib::run()
}
