from pathlib import Path
import soundfile as sf

DATASET = Path("dataset")

for wav in sorted(DATASET.glob("speech_*/audio/*.wav")):
    try:
        info = sf.info(wav)

        print(f"\n{wav}")
        print(f"  Sample rate : {info.samplerate} Hz")
        print(f"  Channels    : {info.channels}")
        print(f"  Duration    : {info.duration:.2f} sec")
        print(f"  Format      : {info.format}")
        print(f"  Subtype     : {info.subtype}")

        assert info.samplerate == 16000, "Wrong sample rate"
        assert info.channels == 1, "Not mono"

        print("  ✓ VALID")

    except Exception as e:
        print(f"  ✗ ERROR: {e}")