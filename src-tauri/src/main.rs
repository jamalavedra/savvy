// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = savvy_dossier::extraction_worker() {
        std::process::exit(code);
    }
    savvy_lib::run()
}
