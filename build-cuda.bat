@echo off
REM Dev helper: run ANY command with the CUDA + MSVC environment set up so
REM whisper-rs-sys can compile whisper.cpp with CUDA (nvcc needs cl.exe on PATH,
REM which vcvars provides). Using this consistently keeps CUDA_PATH/etc. stable
REM so whisper-rs-sys doesn't spuriously rebuild. Machine-specific paths — this
REM single-user app targets exactly this box. Usage:
REM   build-cuda.bat cargo build --manifest-path src-tauri\Cargo.toml
REM   build-cuda.bat npm run tauri dev
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
set "CUDA_PATH=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3"
REM The VS/MSBuild CUDA integration resolves CudaToolkitDir from the
REM version-specific var; set it explicitly (a pre-existing shell may lack it).
set "CUDA_PATH_V13_3=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.3"
set "LIBCLANG_PATH=C:\Program Files\LLVM\bin"
REM cmake 4.x rejects very old cmake_minimum_required(); allow them.
set "CMAKE_POLICY_VERSION_MINIMUM=3.5"
set "PATH=%USERPROFILE%\.cargo\bin;C:\Program Files\CMake\bin;%CUDA_PATH%\bin;%CUDA_PATH%\bin\x64;%LIBCLANG_PATH%;%PATH%"
%*
