import importlib.util
import unittest
from datetime import datetime
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "generate_controlled_scenario.py"
SPEC = importlib.util.spec_from_file_location("controlled_generator", MODULE_PATH)
generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generator)


class ControlledGeneratorTests(unittest.TestCase):
    def test_unique_fixture_shape_and_small_watermark_advance(self):
        rows = generator.generate("abc123", datetime(2026, 10, 20, 10, 0, 0))
        payments = rows[:-1]
        self.assertEqual(len(payments), 16)
        self.assertEqual(len({row["transaction_id"] for row in rows}), 17)
        self.assertTrue(all("abc123" in row["transaction_id"] for row in rows))
        self.assertEqual(rows[-1]["user_id"], "__watermark__")
        self.assertEqual(rows[-1]["event_time"], "2026-10-20 10:00:07.000")


if __name__ == "__main__":
    unittest.main()
