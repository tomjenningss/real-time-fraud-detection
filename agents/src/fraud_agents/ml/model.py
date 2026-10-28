from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import lightgbm as lgb
import numpy as np
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)

from . import FEATURE_SCHEMA_VERSION
from .features import FEATURE_NAMES, FeatureVector


def _read(path: Path) -> tuple[dict[str, np.ndarray], str]:
    buckets: dict[str, list[tuple[list[float], int]]] = {k: [] for k in ("train", "validation", "test")}
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for raw in source:
            digest.update(raw)
            row = json.loads(raw)
            buckets[row["split"]].append(([row[name] for name in FEATURE_NAMES], row["label"]))
    result = {}
    for split, rows in buckets.items():
        result[f"x_{split}"] = np.asarray([r[0] for r in rows], dtype=float)
        result[f"y_{split}"] = np.asarray([r[1] for r in rows], dtype=int)
    return result, digest.hexdigest()


def _metrics(y: np.ndarray, p: np.ndarray, threshold: float) -> dict[str, Any]:
    predicted = p >= threshold
    tn, fp, fn, tp = confusion_matrix(y, predicted, labels=[0, 1]).ravel()
    return {
        "roc_auc": roc_auc_score(y, p),
        "pr_auc": average_precision_score(y, p),
        "precision": precision_score(y, predicted, zero_division=0),
        "recall": recall_score(y, predicted, zero_division=0),
        "f1": f1_score(y, predicted, zero_division=0),
        "confusion_matrix": [[int(tn), int(fp)], [int(fn), int(tp)]],
        "false_positive_rate": fp / (fp + tn),
        "brier_score": brier_score_loss(y, p),
        "threshold": threshold,
    }


def train(dataset: Path, artifact_dir: Path, seed: int = 20261028, threads: int | None = None) -> dict:
    arrays, dataset_sha = _read(dataset)
    threads = threads or int(os.getenv("FRAUD_ML_CPU_THREADS", "6"))
    config = {
        "device_type": "cpu",
        "n_jobs": threads,
        "random_state": seed,
        "n_estimators": 300,
        "learning_rate": 0.04,
        "num_leaves": 31,
        "min_child_samples": 40,
        "subsample": 0.9,
        "colsample_bytree": 0.9,
        "verbosity": -1,
    }
    model = lgb.LGBMClassifier(**config)
    started = time.perf_counter()
    model.fit(
        arrays["x_train"],
        arrays["y_train"],
        eval_X=arrays["x_validation"],
        eval_y=arrays["y_validation"],
        callbacks=[lgb.early_stopping(30, verbose=False)],
    )
    training_seconds = time.perf_counter() - started
    validation_p = model.predict_proba(arrays["x_validation"])[:, 1]
    thresholds = np.linspace(0.02, 0.8, 157)
    threshold = float(max(thresholds, key=lambda t: f1_score(arrays["y_validation"], validation_p >= t)))
    test_started = time.perf_counter_ns()
    test_p = model.predict_proba(arrays["x_test"])[:, 1]
    inference_ms = (time.perf_counter_ns() - test_started) / 1_000_000 / len(test_p)
    version = f"lgbm-baseline-{datetime.now(UTC):%Y%m%dT%H%M%SZ}-{dataset_sha[:8]}"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    model.booster_.save_model(str(artifact_dir / "model.txt"))
    metadata = {
        "model_version": version,
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "feature_names": list(FEATURE_NAMES),
        "training_config": config,
        "dataset": {"path": str(dataset), "sha256": dataset_sha},
        "threshold_selection": "maximum F1 on validation split",
        "threshold": threshold,
        "validation_metrics": _metrics(arrays["y_validation"], validation_p, threshold),
        "test_metrics": _metrics(arrays["y_test"], test_p, threshold),
        "training_seconds": training_seconds,
        "mean_batch_inference_ms_per_record": inference_ms,
        "feature_importance_gain": dict(
            zip(
                FEATURE_NAMES, model.booster_.feature_importance(importance_type="gain").tolist(), strict=True
            )
        ),
        "created_at": datetime.now(UTC).isoformat(),
    }
    (artifact_dir / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n")
    return metadata


def evaluate(dataset: Path, artifact_dir: Path) -> dict[str, Any]:
    arrays, dataset_sha = _read(dataset)
    model = BaselineModel.load(artifact_dir)
    if model.metadata["dataset"]["sha256"] != dataset_sha:
        raise ValueError("evaluation dataset does not match model provenance")
    probabilities = model.booster.predict(arrays["x_test"])
    return {
        "model_version": model.metadata["model_version"],
        "held_out_split": "test",
        "rows": len(arrays["y_test"]),
        "metrics": _metrics(arrays["y_test"], probabilities, float(model.metadata["threshold"])),
    }


@dataclass
class BaselineModel:
    booster: lgb.Booster
    metadata: dict[str, Any]

    @classmethod
    def load(cls, artifact_dir: Path) -> BaselineModel:
        metadata = json.loads((artifact_dir / "metadata.json").read_text())
        if metadata["feature_names"] != list(FEATURE_NAMES):
            raise ValueError("model feature order does not match runtime schema")
        if metadata["feature_schema_version"] != FEATURE_SCHEMA_VERSION:
            raise ValueError("model feature schema is incompatible")
        return cls(lgb.Booster(model_file=str(artifact_dir / "model.txt")), metadata)

    def score(self, vector: FeatureVector) -> float:
        value = float(self.booster.predict(np.asarray([vector.values], dtype=float))[0])
        if not 0 <= value <= 1:
            raise ValueError("model returned invalid probability")
        return value
