\# RhetorTrace — Project Specification



\## Problem



RhetorTrace is a speech evaluation system that compares a speaker's delivery against good reference deliveries of the same script.



It identifies delivery flaws, locates them precisely in time, explains the measurable acoustic evidence, and produces a reproducible delivery score.



\## Primary Mode



Scripted speech analysis.



Input:

\- Audio

\- Transcript



Pipeline:

Audio + Transcript

→ Forced Alignment

→ Acoustic Feature Extraction

→ Reference Comparison

→ Temporal Flaw Detection

→ Scoring

→ Evidence-based Explanation



\## Core Flaws



1\. Too fast

2\. Too slow

3\. Missing pauses

4\. Long/misplaced pauses

5\. Monotone / insufficient pitch variation

6\. Energy / volume drop

7\. Fillers / disfluency

8\. Combined flaws



\## Severity



0 — Control / no intentional flaw

1 — Almost perfect

2 — Noticeable

3 — Strong

4 — Severe



\## Acoustic Features



\- F0 / pitch

\- Pitch variation

\- Energy

\- Speech rate

\- Pause duration and placement

\- MFCC

\- Spectral features

\- Voice-quality features where reliable



\## Reference Baseline



Use multiple good deliveries of the same script.



For each word and feature, calculate a tolerance band from good-reference variation.



Flag deviations outside the tolerance band.



\## Scoring



| Dimension | Weight |

|---|---:|

| Pacing | 25% |

| Pitch variation | 25% |

| Pauses | 20% |

| Energy | 15% |

| Clarity | 15% |



The scoring system is deterministic.



The LLM must not determine the numerical score.



\## Temporal Grounding



Every detected flaw should contain:



\- Start timestamp

\- End timestamp

\- Affected words

\- Flaw type

\- Severity

\- Measured feature values

\- Reference values

\- Deviation

\- Confidence



\## Evaluation



\- Temporal boundary error

\- IoU

\- Precision

\- Recall

\- F1

\- False-positive rate

\- Severity monotonicity

\- Speaker invariance

\- Robustness



\## Reproducibility



\- Fixed configuration

\- Pinned dependencies

\- Fixed random seeds

\- Deterministic scoring

\- Repeatability tests

\- Docker support



\## Dashboard



Audio + Transcript

→ Analysis

→ Score

→ Timeline

→ Flaw Selection

→ Evidence

→ Explanation



Planned additions:

\- Delivery Fingerprint

\- Rhetorical Impact Map

\- Before/After replay

\- Rubric sensitivity

