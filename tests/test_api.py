import unittest

import api


class ApiEndpointTests(unittest.TestCase):
    def test_model_endpoint_returns_persisted_metrics(self):
        result = api.model()

        self.assertIsInstance(result, dict)
        self.assertEqual(result["model"], "HistGradientBoosting on observable metrics + dependency-graph features")
        self.assertIn("auc_full", result)
        self.assertIn("false_alarms_healthy", result)


if __name__ == "__main__":
    unittest.main()
