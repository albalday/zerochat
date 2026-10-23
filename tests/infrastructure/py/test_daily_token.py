import os
import tempfile
import unittest
from unittest import mock

from backend import zerochat


class DailyTokenTest(unittest.TestCase):
    def test_el_token_diario_es_estable_en_el_mismo_dia_y_largo(self):
        with tempfile.TemporaryDirectory() as data_dir, mock.patch.dict(os.environ, {"ZEROCHAT_DATA_DIR": data_dir}):
            token = zerochat.get_daily_token()
            self.assertEqual(zerochat.get_daily_token(), token)
            self.assertGreater(len(token), 20)

