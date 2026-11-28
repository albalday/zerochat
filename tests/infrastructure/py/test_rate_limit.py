import threading
import unittest
from unittest.mock import patch

from backend import zerochat


class RateLimiterTest(unittest.TestCase):
    def test_la_separacion_cuenta_desde_la_respuesta_anterior_y_falla_enseguida_si_supera_max_wait(self):
        clock = [100.0]

        def advance(timeout=None):
            clock[0] += timeout or 0.0
            return False

        with patch.object(zerochat.time, "monotonic", side_effect=lambda: clock[0]):
            limiter = zerochat.RateLimiter()
            policy = zerochat.RatePolicy(concurrency=1, min_interval_s=0.5)
            with patch.object(limiter._condition, "wait", side_effect=advance):
                # Si la espera necesaria supera max_wait_s, falla enseguida sin avanzar el reloj.
                with self.assertRaisesRegex(zerochat.RateLimitBusy, "web está ocupado"), limiter.slot("web", policy, max_wait_s=0.2):
                    pass
                self.assertEqual(clock[0], 100.0)
                # La primera tras crear el limitador (el arranque del proceso) espera la separación.
                with limiter.slot("web", policy, max_wait_s=2) as waited:
                    self.assertAlmostEqual(waited, 0.5)
                # Se cuenta desde que terminó la anterior, no desde que empezó.
                with limiter.slot("web", policy):
                    clock[0] += 0.1
                with limiter.slot("web", policy) as waited:
                    self.assertAlmostEqual(waited, 0.5)
                # Cada recurso lleva su cuenta: uno sin separación no espera a los demás, pero si está ocupado agota max_wait_s.
                with limiter.slot("otro", zerochat.RatePolicy(concurrency=1)) as waited:
                    self.assertEqual(waited, 0.0)
                with limiter.slot("lleno", zerochat.RatePolicy()), self.assertRaises(zerochat.RateLimitBusy):
                    with limiter.slot("lleno", zerochat.RatePolicy(), max_wait_s=0.1):
                        pass

    def test_solo_entran_a_la_vez_las_llamadas_que_admite_y_las_demas_esperan_su_turno(self):
        for concurrency in (1, 2):
            with self.subTest(concurrency=concurrency):
                limiter = zerochat.RateLimiter()
                policy = zerochat.RatePolicy(concurrency=concurrency)
                barrier = threading.Barrier(concurrency, timeout=2.0)
                inside, peak, lock = [0], [0], threading.Lock()

                def call():
                    with limiter.slot("mcp:demo", policy):
                        with lock:
                            inside[0] += 1
                            peak[0] = max(peak[0], inside[0])
                        barrier.wait()
                        with lock:
                            inside[0] -= 1

                threads = [threading.Thread(target=call) for _ in range(4)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()
                self.assertEqual(peak[0], concurrency)

    def test_rate_limit_declarado_admite_solo_valores_dentro_de_sus_topes(self):
        parse = zerochat.parse_rate_policy
        self.assertEqual(parse({"concurrency": 1, "minIntervalS": 0}), zerochat.RatePolicy(1, 0.0))
        self.assertEqual(parse({"concurrency": 64, "minIntervalS": 60}), zerochat.RatePolicy(64, 60.0))
        self.assertEqual(parse({"minIntervalS": 1.1}), zerochat.RatePolicy(1, 1.1))
        for broken in (None, [], {"concurrency": 0}, {"concurrency": 65}, {"concurrency": True}, {"concurrency": 1.5},
                       {"minIntervalS": -0.1}, {"minIntervalS": 60.1}, {"minIntervalS": "1"}, {"minIntervalS": False}):
            with self.subTest(broken=broken):
                self.assertIsNone(parse(broken))


if __name__ == "__main__":
    unittest.main()
