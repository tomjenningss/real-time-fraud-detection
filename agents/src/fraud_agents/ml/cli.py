from __future__ import annotations

import argparse
import json
from pathlib import Path

from .model import evaluate, train
from .synthetic import generate


def main() -> None:
    parser = argparse.ArgumentParser(description="Experimental LightGBM fraud baseline")
    commands = parser.add_subparsers(dest="command", required=True)
    data = commands.add_parser("generate-data")
    data.add_argument("--output", type=Path, default=Path("data/ml/synthetic-v1.jsonl"))
    data.add_argument("--rows", type=int, default=50_000)
    data.add_argument("--seed", type=int, default=20261028)
    fit = commands.add_parser("train")
    fit.add_argument("--dataset", type=Path, default=Path("data/ml/synthetic-v1.jsonl"))
    fit.add_argument("--artifact-dir", type=Path, default=Path("artifacts/baseline"))
    fit.add_argument("--seed", type=int, default=20261028)
    fit.add_argument("--threads", type=int)
    assessment = commands.add_parser("evaluate")
    assessment.add_argument("--dataset", type=Path, default=Path("data/ml/synthetic-v1.jsonl"))
    assessment.add_argument("--artifact-dir", type=Path, default=Path("artifacts/baseline"))
    args = parser.parse_args()
    if args.command == "generate-data":
        result = generate(args.output, args.rows, args.seed)
    elif args.command == "train":
        result = train(args.dataset, args.artifact_dir, args.seed, args.threads)
    else:
        result = evaluate(args.dataset, args.artifact_dir)
    print(json.dumps(result, indent=2, sort_keys=True))
