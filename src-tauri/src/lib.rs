use midir::{MidiInput, MidiInputConnection};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, State};

struct MidiState {
    connection: Mutex<Option<MidiInputConnection<()>>>,
}

#[derive(Serialize, Clone)]
struct MidiDevice {
    id: usize,
    name: String,
}

#[derive(Serialize, Clone)]
struct MidiNoteEvent {
    note: String,
}

const NOTE_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

fn midi_number_to_note(num: u8) -> String {
    let name = NOTE_NAMES[(num % 12) as usize];
    let octave = (num as i32 / 12) - 2;
    format!("{}{}", name, octave)
}

#[tauri::command]
fn get_midi_inputs() -> Vec<MidiDevice> {
    let midi_in = match MidiInput::new("pianly-list") {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[MIDI] Failed to create MidiInput: {}", e);
            return vec![];
        }
    };

    let ports = midi_in.ports();
    ports
        .iter()
        .enumerate()
        .filter_map(|(i, port)| {
            midi_in
                .port_name(port)
                .ok()
                .map(|name| MidiDevice { id: i, name })
        })
        .collect()
}

#[tauri::command]
fn connect_midi(
    device_id: usize,
    app: tauri::AppHandle,
    state: State<'_, MidiState>,
) -> Result<String, String> {
    // Close existing connection
    {
        let mut conn = state.connection.lock().unwrap();
        if let Some(c) = conn.take() {
            drop(c);
        }
    }

    let midi_in = MidiInput::new("pianly-input")
        .map_err(|e| format!("Failed to create MIDI input: {}", e))?;

    let ports = midi_in.ports();
    let port = ports
        .get(device_id)
        .ok_or_else(|| format!("Device index {} not found", device_id))?;

    let port_name = midi_in
        .port_name(port)
        .unwrap_or_else(|_| "Unknown".to_string());

    let app_handle = app.clone();
    let connection = midi_in
        .connect(
            port,
            "pianly-read",
            move |_timestamp, message, _| {
                if message.len() >= 3 {
                    let status = message[0] & 0xf0;
                    if status == 0x90 && message[2] > 0 {
                        // noteOn
                        let note = midi_number_to_note(message[1]);
                        let _ = app_handle.emit("midi-note", MidiNoteEvent { note });
                    } else if status == 0x80 || (status == 0x90 && message[2] == 0) {
                        // noteOff
                        let note = midi_number_to_note(message[1]);
                        let _ = app_handle.emit("midi-note-off", MidiNoteEvent { note });
                    }
                }
            },
            (),
        )
        .map_err(|e| format!("Failed to connect to {}: {}", port_name, e))?;

    let mut conn = state.connection.lock().unwrap();
    *conn = Some(connection);

    log::info!("[MIDI] Connected: {}", port_name);
    Ok(port_name)
}

#[tauri::command]
fn disconnect_midi(state: State<'_, MidiState>) {
    let mut conn = state.connection.lock().unwrap();
    if let Some(c) = conn.take() {
        drop(c);
        log::info!("[MIDI] Disconnected");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(MidiState {
            connection: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_midi_inputs,
            connect_midi,
            disconnect_midi,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
