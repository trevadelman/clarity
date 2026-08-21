//! Auto-Edit rendering: splice time ranges from local videos into one MP4,
//! optionally with a music track, using AVFoundation (macOS system
//! framework — nothing bundled, hardware-accelerated export).
//!
//! The render runs on a blocking thread: build an AVMutableComposition
//! (frame-accurate trims, orientation-correct layer instructions,
//! AVMutableAudioMix per the requested audio mode), export with
//! AVAssetExportSession, and poll `progress` to emit `auto-edit-progress`
//! events. Output is written to a temp file and atomically renamed so a
//! crashed export never leaves a corrupt "successful" file.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{State, Window};

/// One trimmed segment of a source video (times in seconds).
#[derive(Deserialize)]
pub struct RenderClip {
    pub path: String,
    pub start_sec: f64,
    pub end_sec: f64,
}

/// Optional music track. `mode` is "replace" (music only) or "mix"
/// (music under the original audio).
#[derive(Deserialize)]
pub struct RenderAudio {
    pub path: String,
    pub mode: String,
}

#[derive(Deserialize)]
pub struct RenderRequest {
    pub job_id: String,
    pub clips: Vec<RenderClip>,
    pub audio: Option<RenderAudio>,
    pub width: f64,
    pub height: f64,
    pub output_path: String,
}

#[derive(Serialize)]
pub struct RenderResult {
    pub duration_sec: f64,
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    job_id: String,
    progress: f64,
}

/// Cancellation flags for in-flight renders, keyed by job id. The export
/// session itself is not Send, so the render thread owns it and checks
/// this flag between progress polls.
#[derive(Default)]
pub struct EditJobs {
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[tauri::command]
pub fn cancel_render(state: State<EditJobs>, job_id: String) -> Result<(), String> {
    let flags = state.cancel_flags.lock().unwrap();
    match flags.get(&job_id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err(format!("No render in progress with id {job_id}")),
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn render_edit(
    _window: Window,
    _state: State<'_, EditJobs>,
    _request: RenderRequest,
) -> Result<RenderResult, String> {
    Err("Auto-Edit requires macOS.".into())
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn render_edit(
    window: Window,
    state: State<'_, EditJobs>,
    request: RenderRequest,
) -> Result<RenderResult, String> {
    validate_request(&request)?;

    let cancel = Arc::new(AtomicBool::new(false));
    state
        .cancel_flags
        .lock()
        .unwrap()
        .insert(request.job_id.clone(), cancel.clone());
    let job_id = request.job_id.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        macos::render(&window, &request, &cancel)
    })
    .await
    .map_err(|e| e.to_string());

    // The flag entry is only meaningful while the render is live.
    state.cancel_flags.lock().unwrap().remove(&job_id);
    result?
}

fn validate_request(request: &RenderRequest) -> Result<(), String> {
    if request.clips.is_empty() {
        return Err("Edit plan has no clips.".into());
    }
    if !(256.0..=3840.0).contains(&request.width) || !(256.0..=3840.0).contains(&request.height) {
        return Err("Output dimensions out of range.".into());
    }
    for clip in &request.clips {
        if !std::path::Path::new(&clip.path).is_file() {
            return Err(format!("Source video not found: {}", clip.path));
        }
        if clip.start_sec < 0.0 || clip.end_sec <= clip.start_sec {
            return Err(format!(
                "Invalid clip range {}–{} for {}",
                clip.start_sec, clip.end_sec, clip.path
            ));
        }
    }
    if let Some(audio) = &request.audio {
        if !std::path::Path::new(&audio.path).is_file() {
            return Err(format!("Audio file not found: {}", audio.path));
        }
        if audio.mode != "replace" && audio.mode != "mix" {
            return Err(format!("Unknown audio mode: {}", audio.mode));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{ProgressPayload, RenderRequest, RenderResult};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_av_foundation::{
        AVAsset, AVAssetExportPresetHighestQuality, AVAssetExportSession,
        AVAssetExportSessionStatus, AVAssetTrack, AVFileTypeMPEG4, AVMediaTypeAudio,
        AVMediaTypeVideo, AVMutableAudioMix, AVMutableAudioMixInputParameters,
        AVMutableComposition, AVMutableCompositionTrack, AVMutableVideoComposition,
        AVMutableVideoCompositionInstruction, AVMutableVideoCompositionLayerInstruction,
        AVURLAsset, AVVideoCompositionInstructionProtocol,
    };
    use objc2_core_foundation::{CGAffineTransform, CGPoint, CGSize};
    use objc2_core_media::{CMTime, CMTimeFlags, CMTimeRange};
    use objc2_foundation::{NSArray, NSString, NSURL};
    use tauri::{Emitter, Window};

    /// Standard timescale for mixed-framerate footage (divisible by 24,
    /// 25, 30, and 60).
    const TIMESCALE: i32 = 600;
    /// Music volume when mixed under the original audio.
    const MIX_MUSIC_VOLUME: f32 = 0.35;
    /// Length of the music fade-out at the end of the edit.
    const FADE_OUT_SEC: f64 = 1.0;

    fn time(seconds: f64) -> CMTime {
        CMTime {
            value: (seconds * TIMESCALE as f64).round() as i64,
            timescale: TIMESCALE,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        }
    }

    fn range(start_sec: f64, end_sec: f64) -> CMTimeRange {
        CMTimeRange {
            start: time(start_sec),
            duration: time(end_sec - start_sec),
        }
    }

    fn seconds(t: CMTime) -> f64 {
        if t.timescale == 0 {
            return 0.0;
        }
        t.value as f64 / t.timescale as f64
    }

    /// CGAffineTransformConcat: apply `a` then `b`.
    fn concat(a: CGAffineTransform, b: CGAffineTransform) -> CGAffineTransform {
        CGAffineTransform {
            a: a.a * b.a + a.b * b.c,
            b: a.a * b.b + a.b * b.d,
            c: a.c * b.a + a.d * b.c,
            d: a.c * b.b + a.d * b.d,
            tx: a.tx * b.a + a.ty * b.c + b.tx,
            ty: a.tx * b.b + a.ty * b.d + b.ty,
        }
    }

    fn translation(tx: f64, ty: f64) -> CGAffineTransform {
        CGAffineTransform { a: 1.0, b: 0.0, c: 0.0, d: 1.0, tx, ty }
    }

    fn scale(s: f64) -> CGAffineTransform {
        CGAffineTransform { a: s, b: 0.0, c: 0.0, d: s, tx: 0.0, ty: 0.0 }
    }

    fn apply(t: CGAffineTransform, p: CGPoint) -> CGPoint {
        CGPoint {
            x: p.x * t.a + p.y * t.c + t.tx,
            y: p.x * t.b + p.y * t.d + t.ty,
        }
    }

    /// Bounding box of the source rect after its preferred transform —
    /// iPhone footage carries rotation in metadata, so the displayed size
    /// often swaps width/height and shifts origin.
    fn display_bounds(t: CGAffineTransform, size: CGSize) -> (f64, f64, f64, f64) {
        let corners = [
            CGPoint { x: 0.0, y: 0.0 },
            CGPoint { x: size.width, y: 0.0 },
            CGPoint { x: 0.0, y: size.height },
            CGPoint { x: size.width, y: size.height },
        ];
        let pts: Vec<CGPoint> = corners.iter().map(|p| apply(t, *p)).collect();
        let min_x = pts.iter().map(|p| p.x).fold(f64::INFINITY, f64::min);
        let min_y = pts.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let max_x = pts.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
        let max_y = pts.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
        (max_x - min_x, max_y - min_y, min_x, min_y)
    }

    /// Orientation-correct aspect-fit transform: preferred transform,
    /// normalized to origin, scaled to fit, centered (letter/pillarbox).
    fn fit_transform(
        preferred: CGAffineTransform,
        natural: CGSize,
        out_w: f64,
        out_h: f64,
    ) -> CGAffineTransform {
        let (dw, dh, min_x, min_y) = display_bounds(preferred, natural);
        let s = (out_w / dw).min(out_h / dh);
        let t = concat(preferred, translation(-min_x, -min_y));
        let t = concat(t, scale(s));
        concat(
            t,
            translation((out_w - dw * s) / 2.0, (out_h - dh * s) / 2.0),
        )
    }

    /// AVMediaType/AVFileType constants come through as Options of statics;
    /// they are always present at runtime on macOS.
    fn media_video() -> &'static objc2_av_foundation::AVMediaType {
        unsafe { AVMediaTypeVideo }.expect("AVMediaTypeVideo")
    }

    fn media_audio() -> &'static objc2_av_foundation::AVMediaType {
        unsafe { AVMediaTypeAudio }.expect("AVMediaTypeAudio")
    }

    fn load_asset(path: &str) -> Result<Retained<AVURLAsset>, String> {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        Ok(unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) })
    }

    fn first_track(
        asset: &AVAsset,
        media_type: &objc2_av_foundation::AVMediaType,
        path: &str,
        kind: &str,
    ) -> Result<Retained<AVAssetTrack>, String> {
        #[allow(deprecated)]
        let tracks = unsafe { asset.tracksWithMediaType(media_type) };
        tracks
            .firstObject()
            .ok_or_else(|| format!("No {kind} track in {path}"))
    }

    fn asset_duration_sec(asset: &AVAsset) -> f64 {
        #[allow(deprecated)]
        let d = unsafe { asset.duration() };
        seconds(d)
    }

    struct Composition {
        composition: Retained<AVMutableComposition>,
        video_composition: Retained<AVMutableVideoComposition>,
        audio_mix: Option<Retained<AVMutableAudioMix>>,
        duration_sec: f64,
    }

    /// Build the full timeline: trimmed video segments back to back, the
    /// original audio (unless replaced), the music track (trimmed/looped),
    /// per-clip orientation/fit instructions, and the volume mix.
    fn build_composition(request: &RenderRequest) -> Result<Composition, String> {
        let composition = unsafe { AVMutableComposition::new() };
        let video_track = add_track(&composition, media_video())?;
        let keep_original_audio = request
            .audio
            .as_ref()
            .map(|a| a.mode == "mix")
            .unwrap_or(true);
        let original_audio_track = if keep_original_audio {
            Some(add_track(&composition, media_audio())?)
        } else {
            None
        };

        let mut cursor = 0.0_f64;
        let mut instructions: Vec<
            Retained<ProtocolObject<dyn AVVideoCompositionInstructionProtocol>>,
        > = Vec::new();

        for clip in &request.clips {
            let asset = load_asset(&clip.path)?;
            let duration = asset_duration_sec(&asset);
            if clip.end_sec > duration + 0.05 {
                return Err(format!(
                    "Clip range {}–{}s exceeds the {:.1}s duration of {}",
                    clip.start_sec, clip.end_sec, duration, clip.path
                ));
            }
            let end_sec = clip.end_sec.min(duration);
            let src_range = range(clip.start_sec, end_sec);
            let at = time(cursor);

            let src_video = first_track(&asset, media_video(), &clip.path, "video")?;
            insert(&video_track, src_range, &src_video, at, &clip.path)?;

            if let Some(audio_track) = &original_audio_track {
                // Videos without sound (screen recordings, muted clips)
                // simply contribute silence — not an error.
                #[allow(deprecated)]
                let audio_tracks = unsafe { asset.tracksWithMediaType(media_audio()) };
                if let Some(src_audio) = audio_tracks.firstObject() {
                    insert(audio_track, src_range, &src_audio, at, &clip.path)?;
                }
            }

            instructions.push(clip_instruction(
                &video_track,
                &src_video,
                cursor,
                end_sec - clip.start_sec,
                request.width,
                request.height,
            ));
            cursor += end_sec - clip.start_sec;
        }

        let mut audio_mix = None;
        if let Some(audio) = &request.audio {
            let music_track = add_track(&composition, media_audio())?;
            fill_music_track(&music_track, &audio.path, cursor)?;
            let volume = if audio.mode == "mix" { MIX_MUSIC_VOLUME } else { 1.0 };
            audio_mix = Some(music_mix(&music_track, volume, cursor));
        }

        let video_composition = unsafe { AVMutableVideoComposition::videoComposition() };
        unsafe {
            video_composition.setRenderSize(CGSize {
                width: request.width,
                height: request.height,
            });
            video_composition.setFrameDuration(CMTime {
                value: 1,
                timescale: 30,
                flags: CMTimeFlags::Valid,
                epoch: 0,
            });
            video_composition.setInstructions(&NSArray::from_retained_slice(&instructions));
        }

        Ok(Composition {
            composition,
            video_composition,
            audio_mix,
            duration_sec: cursor,
        })
    }

    fn add_track(
        composition: &AVMutableComposition,
        media_type: &objc2_av_foundation::AVMediaType,
    ) -> Result<Retained<AVMutableCompositionTrack>, String> {
        // 0 = kCMPersistentTrackID_Invalid: let AVFoundation pick an id.
        unsafe { composition.addMutableTrackWithMediaType_preferredTrackID(media_type, 0) }
            .ok_or_else(|| "Could not add a composition track.".to_string())
    }

    fn insert(
        dest: &AVMutableCompositionTrack,
        src_range: CMTimeRange,
        src: &AVAssetTrack,
        at: CMTime,
        path: &str,
    ) -> Result<(), String> {
        unsafe { dest.insertTimeRange_ofTrack_atTime_error(src_range, src, at) }
            .map_err(|e| format!("Failed inserting {path}: {}", e.localizedDescription()))
    }

    /// A single-layer instruction covering one clip's slot in the output
    /// timeline, with its orientation-correct aspect-fit transform.
    fn clip_instruction(
        video_track: &AVMutableCompositionTrack,
        src_video: &AVAssetTrack,
        start_sec: f64,
        length_sec: f64,
        out_w: f64,
        out_h: f64,
    ) -> Retained<ProtocolObject<dyn AVVideoCompositionInstructionProtocol>> {
        let preferred = unsafe { src_video.preferredTransform() };
        let natural = unsafe { src_video.naturalSize() };
        let transform = fit_transform(preferred, natural, out_w, out_h);

        let layer = unsafe {
            AVMutableVideoCompositionLayerInstruction::videoCompositionLayerInstructionWithAssetTrack(
                video_track,
            )
        };
        unsafe { layer.setTransform_atTime(transform, time(start_sec)) };

        let instruction = unsafe { AVMutableVideoCompositionInstruction::new() };
        unsafe {
            instruction.setTimeRange(range(start_sec, start_sec + length_sec));
            instruction.setLayerInstructions(&NSArray::from_retained_slice(&[
                Retained::into_super(layer),
            ]));
        }
        ProtocolObject::from_retained(Retained::into_super(instruction))
    }

    /// Fill the music track for the composition's full duration: trim a
    /// longer song, loop a shorter one.
    fn fill_music_track(
        track: &AVMutableCompositionTrack,
        path: &str,
        total_sec: f64,
    ) -> Result<(), String> {
        let asset = load_asset(path)?;
        let src = first_track(&asset, media_audio(), path, "audio")?;
        let src_sec = asset_duration_sec(&asset);
        if src_sec <= 0.0 {
            return Err(format!("Audio file has no duration: {path}"));
        }
        let mut cursor = 0.0_f64;
        while cursor < total_sec {
            let take = (total_sec - cursor).min(src_sec);
            insert(track, range(0.0, take), &src, time(cursor), path)?;
            cursor += take;
        }
        Ok(())
    }

    /// Volume for the music track (full for "replace", ducked for "mix")
    /// with a fade-out over the last second of the edit.
    fn music_mix(
        track: &AVMutableCompositionTrack,
        volume: f32,
        total_sec: f64,
    ) -> Retained<AVMutableAudioMix> {
        let params = unsafe {
            AVMutableAudioMixInputParameters::audioMixInputParametersWithTrack(Some(track))
        };
        let fade_start = (total_sec - FADE_OUT_SEC).max(0.0);
        unsafe {
            params.setVolume_atTime(volume, time(0.0));
            params.setVolumeRampFromStartVolume_toEndVolume_timeRange(
                volume,
                0.0,
                range(fade_start, total_sec),
            );
        }
        let mix = unsafe { AVMutableAudioMix::audioMix() };
        unsafe {
            mix.setInputParameters(&NSArray::from_retained_slice(&[Retained::into_super(
                params,
            )]));
        }
        mix
    }

    /// Run the export, polling progress and honoring cancellation. Blocks
    /// until the session finishes (the command wraps this in
    /// spawn_blocking).
    fn export(
        window: &Window,
        request: &RenderRequest,
        built: &Composition,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        let output = std::path::Path::new(&request.output_path);
        if let Some(dir) = output.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp_path = request.output_path.clone() + ".tmp.mp4";
        let _ = std::fs::remove_file(&tmp_path);

        let session = unsafe {
            AVAssetExportSession::exportSessionWithAsset_presetName(
                &built.composition,
                AVAssetExportPresetHighestQuality,
            )
        }
        .ok_or("Could not create an export session.")?;

        let url = NSURL::fileURLWithPath(&NSString::from_str(&tmp_path));
        unsafe {
            session.setOutputURL(Some(&url));
            session.setOutputFileType(AVFileTypeMPEG4);
            session.setVideoComposition(Some(&built.video_composition));
            if let Some(mix) = &built.audio_mix {
                session.setAudioMix(Some(mix));
            }
        }

        let (tx, rx) = mpsc::channel::<()>();
        let handler = RcBlock::new(move || {
            let _ = tx.send(());
        });
        #[allow(deprecated)]
        unsafe {
            session.exportAsynchronouslyWithCompletionHandler(&handler)
        };

        // Poll: emit progress every 250ms; honor cancellation between polls.
        loop {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(()) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if cancel.load(Ordering::Relaxed) {
                        #[allow(deprecated)]
                        unsafe {
                            session.cancelExport()
                        };
                        // Completion handler still fires; keep waiting.
                    }
                    #[allow(deprecated)]
                    let progress = unsafe { session.progress() } as f64;
                    let _ = window.emit(
                        "auto-edit-progress",
                        ProgressPayload {
                            job_id: request.job_id.clone(),
                            progress,
                        },
                    );
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        #[allow(deprecated)]
        let status = unsafe { session.status() };
        match status {
            AVAssetExportSessionStatus::Completed => {
                std::fs::rename(&tmp_path, &request.output_path).map_err(|e| e.to_string())?;
                Ok(())
            }
            AVAssetExportSessionStatus::Cancelled => {
                let _ = std::fs::remove_file(&tmp_path);
                Err("Render cancelled.".into())
            }
            _ => {
                let _ = std::fs::remove_file(&tmp_path);
                #[allow(deprecated)]
                let error = unsafe { session.error() };
                Err(match error {
                    Some(e) => format!("Export failed: {}", e.localizedDescription()),
                    None => "Export failed with an unknown error.".into(),
                })
            }
        }
    }

    pub fn render(
        window: &Window,
        request: &RenderRequest,
        cancel: &AtomicBool,
    ) -> Result<RenderResult, String> {
        let built = build_composition(request)?;
        export(window, request, &built, cancel)?;
        Ok(RenderResult {
            duration_sec: built.duration_sec,
        })
    }
}
