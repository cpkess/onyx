mod ai;
mod commands;
mod import;
mod index;
mod night;
mod vault;
mod vector;

use night::NightState;
use vault::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Register the sqlite-vec extension before any DB connection is opened.
    vector::register();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::default())
        .manage(NightState::default())
        .setup(|app| {
            // Start the Night Shift background scheduler (one coarse tick/min).
            night::start_scheduler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_last_vault,
            commands::open_vault,
            commands::get_tree,
            commands::read_note,
            commands::write_note,
            commands::create_note,
            commands::create_folder,
            commands::resolve_asset,
            commands::save_attachment,
            commands::read_vault_meta,
            commands::write_vault_meta,
            commands::move_path,
            commands::rename_path,
            commands::delete_note,
            commands::get_backlinks,
            commands::search_notes,
            commands::get_note_names,
            commands::get_graph,
            commands::reindex,
            commands::resolve_link,
            commands::get_tags,
            commands::get_notes_by_tag,
            commands::get_unlinked_mentions,
            commands::get_pages,
            commands::toggle_task,
            commands::ai_get_config,
            commands::ai_set_config,
            commands::ai_list_models,
            commands::ai_chat,
            commands::ai_index_status,
            commands::ai_index_vault,
            commands::ai_index_note,
            commands::ai_semantic_search,
            commands::ai_complete,
            commands::append_to_note,
            commands::create_note_with_content,
            commands::ai_suggest_tags,
            commands::ai_suggest_links,
            commands::ai_synthesize,
            commands::ai_subject_page,
            commands::ai_regenerate,
            commands::ai_compose_sections,
            commands::ai_rag_chat,
            commands::import_document,
            commands::import_document_bytes,
            night::record_event,
            night::get_night_settings,
            night::set_night_settings,
            night::get_processing_status,
            night::start_processing,
            night::pause_processing,
            night::get_suggestions,
            night::get_morning_review,
            night::accept_suggestion,
            night::dismiss_suggestion,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
