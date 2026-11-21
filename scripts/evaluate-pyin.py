"""Offline comparison; run with the optional librosa==0.11.0 dependency."""
import json
from pathlib import Path
import sys
from time import perf_counter

import librosa
import numpy as np


def compare(directory):
    metadata = json.loads((directory / "fixtures.json").read_text())
    results = {}
    for case in metadata:
        if case["chord"]:
            continue
        samples = np.fromfile(directory / (case["name"] + ".f32"), dtype="<f4")
        sample_rate = case["sampleRate"]
        start = perf_counter()
        frequency, voiced, _ = librosa.pyin(
            samples, fmin=30, fmax=4200, sr=sample_rate, frame_length=4096,
            hop_length=round(sample_rate * 0.024), center=False,
        )
        duration_ms = 1000 * (perf_counter() - start)
        frames = []
        for i, hz in enumerate(frequency):
            if voiced[i] and np.isfinite(hz):
                when = (4096 + i * round(sample_rate * 0.024)) * 1000 / sample_rate
                frames.append({"at": when, "frequencyHz": float(hz), "midi": round(float(librosa.hz_to_midi(hz)))})
        results[case["name"]] = {"frames": frames, "elapsedMs": duration_ms}
    return {"metadata": {"implementation": "librosa.pyin", "version": librosa.__version__}, **results}


if __name__ == "__main__":
    output = compare(Path(sys.argv[1]))
    Path(sys.argv[2]).write_text(json.dumps(output))
