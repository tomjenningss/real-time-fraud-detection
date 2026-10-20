import unittest
from datetime import datetime
from scripts.generate_payments import generate

class GeneratorTests(unittest.TestCase):
    def setUp(self):
        self.rows=generate(datetime(2026, 1, 1, 12, 0))
    def test_unique_ids(self):
        ids=[r['transaction_id'] for r in self.rows]
        self.assertEqual(len(ids), len(set(ids)))
    def test_normal_not_velocity(self):
        self.assertEqual(sum(r['user_id']=='customer-normal' for r in self.rows), 3)
    def test_velocity(self):
        self.assertEqual(sum(r['user_id']=='customer-velocity' for r in self.rows), 6)
    def test_merchants(self):
        self.assertEqual(len({r['merchant_id'] for r in self.rows if r['user_id']=='customer-hopping'}), 7)
    def test_sentinel(self):
        self.assertEqual(self.rows[-1]['user_id'], '__watermark__')

if __name__ == '__main__':
    unittest.main()
