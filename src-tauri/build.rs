use std::path::Path;

fn main() {
    copy_cuda_runtime_dlls();
    tauri_build::build()
}

/// Copy the bundled CUDA runtime DLLs next to the built executable so the app
/// runs from `target/<profile>/` (including `tauri dev`) without CUDA on PATH.
/// The release installer bundles the same DLLs via tauri.conf.json
/// `bundle.resources`; this just covers running the freshly-built exe directly.
fn copy_cuda_runtime_dlls() {
    println!("cargo:rerun-if-changed=resources/cuda");
    let out_dir = match std::env::var("OUT_DIR") {
        Ok(v) => v,
        Err(_) => return,
    };
    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out  ->  ancestors[3] = target/<profile>
    let exe_dir = match Path::new(&out_dir).ancestors().nth(3) {
        Some(p) => p.to_path_buf(),
        None => return,
    };
    let src = Path::new("resources/cuda");
    for dll in ["cudart64_13.dll", "cublas64_13.dll", "cublasLt64_13.dll"] {
        let from = src.join(dll);
        let to = exe_dir.join(dll);
        // Skip if already present (these are large — up to ~440 MB).
        if from.exists() && !to.exists() {
            let _ = std::fs::copy(&from, &to);
        }
    }
}
