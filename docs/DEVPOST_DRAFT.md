# Devpost submission draft: RhetorTrace

> Draft for the team to edit. Every number below comes from `results/validation/EVALUATION.md`,
> `ROBUSTNESS.md` or the dataset outputs in `results/`; keep them in sync if anything is re-run.
> Placeholders are marked **[TODO]**.

## Project name

RhetorTrace

## Tagline

Find the exact moments a speech went off, and hear why: contrastive, time-stamped, evidence-backed
delivery analysis.

## The problem

Feedback on spoken delivery is usually a vague verdict ("a bit fast", "monotone") or a single score.
Neither tells a speaker *which words* went wrong, *by how much*, or *compared with what*, and fixed
norms such as "150 words per minute" ignore that good speakers legitimately differ.

## Inspiration

Rehearsing a talk, you rarely need to be told you are "fine overall"; you need to know that you
rushed the third sentence and paused far too long after one particular word. Musicians compare their
take with a reference recording bar by bar. We wanted the same for speech: compare a delivery with good
deliveries of the same script, word by word, and show the evidence for every comment.

## What we built

* **An analysis pipeline** that takes a recording, its script and two or more good deliveries of the
  same script, and returns time-stamped findings: which words, start and end (with uncertainty),
  category (pacing, pitch, pause, energy, clarity), direction (e.g. too fast, flatter, longer pause),
  severity, confidence, and the measurements that caused each one.
* **Deterministic explanations** built only from those measurements, e.g. *"pause after the word
  'battlefield': 1.101 s vs reference 0.16 s (+0.94 s; z = +9.41). Severity: severe."* No language
  model is involved.
* **A FastAPI job server and a React dashboard** where you can upload a recording, watch the analysis
  stages, and explore the results.
* **A labelled evaluation set and stress tests** to measure how well all of this actually works.

## How it works

1. **Ingest and QC**: audio becomes 16 kHz mono; duration, silence and clipping are checked.
2. **Forced alignment** with WhisperX's wav2vec2 aligner on the *script*, so word *i* is the same word in
   every delivery. Whisper ASR is only a quality gate: an off-script reading is refused.
3. **Per-word features**: pitch (Praat, speaker-normalized semitones), energy (dB re speaker),
   duration and local speaking rate, pauses, MFCC and spectral shape.
4. **Contrastive baseline**: for every word and feature, the median of the good deliveries and a robust
   scale that is stable even with only three references.
5. **Detection**: robust z-scores per word, grouped by category, smoothed, and turned into regions
   with hysteresis (open at z ≥ 3, extend at z ≥ 2).
6. **Refinement**: boundaries trimmed or extended on the evidence, with per-side uncertainty; severity
   from the strongest part of the region, shrunk when evidence is thin.
7. **Explanation and scoring**: evidence-only explanations, and a weighted delivery score as a summary.

## What makes it different

* **Contrast, not rules.** The reference is how good speakers delivered *these words*, not a generic norm.
* **Temporal grounding.** Every finding has word-level boundaries and an uncertainty, not just a label.
* **Causal, verifiable evidence.** Each claim links to the measured value, the reference value and each
  reference speaker's own value; nothing is generated.
* **Measured reliability.** Each good delivery is also a clean control (leave-one-out), and we degrade
  the audio to see what breaks.
* **A dashboard that shows the evidence**: the waveform is coloured where the delivery leaves the
  references' range, "rhythm threads" join each word to the same word in every reference delivery, the
  claim on a finding is linked to the exact span where it was measured, and you can hold a key to hear
  the reference speaker at the same point of the script.

## Technical implementation

* **Python 3.13**: WhisperX 3.8.6, praat-parselmouth 0.4.7, librosa, NumPy, SciPy, FastAPI.
* **Baseline**: per-word median and a moderated scale
  `sqrt((2·pooled² + (n−1)·mad²)/(2 + n−1))`, small-sample-corrected MAD, measurement-resolution floors.
* **Detection safeguards**, each justified on the clean controls and documented in `config.yaml`:
  alignment-frame error added to duration scales, directional pitch tracks, one-sided monotone
  evidence only where the references themselves vary.
* **Dashboard**: React 19, TypeScript, Vite, Tailwind CSS, Motion. A single recording stage persists across
  overview, finding and explorer views; canvas waveform and imperative playhead updates keep playback
  smooth.
* **Tests**: 278 pytest tests, 47 Vitest tests, 3 Playwright end-to-end tests against the real server.

## Dataset

* 2 public-domain scripts (Lincoln's *Gettysburg Address*; an excerpt of Frederick Douglass's *What to
  the Slave Is the Fourth of July?*), 3 good human deliveries each (40.7–49.5 s).
* **126 feature-level injected flaws** (fast, slow, quiet, monotone, mild monotone, long pause, missing
  pause; 3 sites per kind in each of 6 deliveries) with exact ground-truth spans, plus a 4-step severity
  ladder.
* **2 audio-edited demo recordings** (Praat time-compression, stretching, an inserted pause, flattened
  pitch), analysed end to end: 8 labelled flaws.
* Ground truth for the demo recordings: `results/demo/`; injection kinds and sites: `scripts/eval_detection.py`.
* There are **no human recordings with natural flaws** in the dataset yet.

## Evaluation

* **Detection** (116 counted injections, leave-one-out references): precision **0.774**, recall
  **0.888**, F1 **0.827**. Pacing F1 0.895, pause 0.917, energy 0.800, pitch 0.688.
* **Temporal grounding**: long and missing pauses located exactly (IoU 1.000); fast 0.954, quiet 0.952,
  slow 0.835, monotone 0.762.
* **Severity** never decreases as the injected flaw gets stronger: **90 / 90 sites**.
* **Clean deliveries**: 28 false-positive tracks over 6 takes (6.2 per minute).
* **Audio demos**: all **8 / 8** edits found.
* **Stress tests** (10 audio conditions, whole pipeline re-run): recall stays at 86.7–88.7 % under gain
  changes, MP3 and resampling, 84.1 % at 20 dB SNR noise and 60.7 % at 10 dB SNR.
* Every report is regenerated by a script and is byte-identical on re-run.

## Challenges we ran into

* **Three references is very few.** A per-word spread from three values can be almost zero, which makes
  every tiny difference look huge. We moderated each word's scale toward the feature's script-wide spread.
* **Background hum looked like voice.** The recordings carry a steady ~100 Hz hum that pitch trackers
  report as voiced; we gate pitch and spectral frames on energy above the noise floor.
* **Measuring honestly.** Some injected flaws landed where a clean delivery was already flagged; we
  report those as "confounded" instead of counting them as hits, and we count every flag on a clean
  delivery as a false positive.
* **Monotone is subtle.** Flat pitch is a property of a span, not a word; we added a one-sided span
  feature and only use it where the references themselves vary.

## Accomplishments that we're proud of

* Findings that can be checked: every explanation number traces back to a measurement.
* A reproducible evaluation with controls, confounding rules and stress tests, rather than demos only.
* Exact localisation of pause flaws, and a severity that never decreases as a flaw gets stronger, at
  all 90 ladder sites.
* A dashboard where the evidence is visible: the measurement, the reference, and the audio of both.

## What we learned

* Comparing against good deliveries of the same text removes most of the arbitrariness of rule-based
  feedback, but the quality of the reference set is everything: one atypical reference delivery
  caused more than half of our false positives.
* Timing features (duration, rate, pauses) are robust to noise and codecs; spectral features are not.
* A clean control set is the most useful evaluation asset we built: it set every safeguard.

## What's next

* Record **human deliveries with natural, annotated flaws** (and human severity ratings) to validate
  beyond synthetic injections.
* More reference deliveries per script, and a held-out test set for thresholds.
* Filler and disfluency detection; clarity evaluation with labelled examples.
* Script-free mode (comparing against a speaker's own best takes).

## Built with

python · whisperx · wav2vec2 · praat · parselmouth · librosa · numpy · scipy · fastapi · uvicorn ·
react · typescript · vite · tailwindcss · motion · zustand · vitest · playwright · pytest

## Links

* GitHub repository: **[TODO: link]**
* Demo video: **[TODO: link]**
