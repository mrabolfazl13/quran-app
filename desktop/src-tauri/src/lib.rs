mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // SQLite lives in the Rust layer; the JS side only talks to it through
        // @tauri-apps/plugin-sql. No other native plugin is registered: there is
        // no shell plugin, no general filesystem plugin, no HTTP plugin. Backup
        // and pack files reach the disk only through the validated commands below.
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::app_paths,
            commands::content_status,
            commands::content_read_text,
            commands::content_pack_stat,
            commands::backup_write,
            commands::backup_read,
            commands::backup_list
        ])
        .run(tauri::generate_context!())
        .expect("error while running quran desktop");
}
