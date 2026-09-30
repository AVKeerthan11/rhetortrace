import soundfile as sf
import whisperx

audio_file = "dataset/speech_01/audio/good_01.wav"
device = "cpu"
compute_type = "int8"

print("Loading audio...")
audio, sample_rate = sf.read(audio_file, dtype="float32")

print(f"Sample rate: {sample_rate}")
print(f"Duration: {len(audio) / sample_rate:.2f}s")

print("Loading WhisperX...")
model = whisperx.load_model(
    "small",
    device=device,
    compute_type=compute_type
)

print("Transcribing...")
result = model.transcribe(audio)

print("Loading alignment model...")
align_model, metadata = whisperx.load_align_model(
    language_code=result["language"],
    device=device
)

print("Aligning...")
aligned = whisperx.align(
    result["segments"],
    align_model,
    metadata,
    audio,
    device
)

print("\nWORD TIMESTAMPS:")
for segment in aligned["segments"]:
    for word in segment.get("words", []):
        print(
            f"{word['word']:20s} "
            f"{word.get('start', 0):7.2f} → "
            f"{word.get('end', 0):7.2f}"
        )