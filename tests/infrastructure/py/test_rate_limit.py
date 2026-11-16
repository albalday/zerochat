import threading
import time
import unittest

from backend import zerochat


def timed(limiter, key, policy, **kwargs):
    """Segundos que tarda en obtener el turno."""
    started = time.monotonic()
    with limiter.slot(key, policy, **kwargs):
        return time.monotonic() - started


class RateLimiterTest(unittest.TestCase):
    def test_la_separacion_cuenta_desde_la_respuesta_anterior_y_desde_el_arranque(self):
        limiter = zerochat.RateLimiter()
        policy = zerochat.RatePolicy(concurrency=1, min_interval_s=0.2)
        # La primera tras crear el limitador (el arranque del proceso) también espera.
        self.assertGreaterEqual(timed(limiter, "web", policy), 0.18)
        with limiter.slot("web", policy):
            time.sleep(0.1)
        # Se cuenta desde que terminó la anterior, no desde que empezó.
        self.assertGreaterEqual(timed(limiter, "web", policy), 0.18)
        # Cada recurso lleva su cuenta.
        time.sleep(0.2)
        self.assertLess(timed(limiter, "otro", zerochat.RatePolicy(concurrency=1)), 0.05)

    def test_solo_entran_a_la_vez_las_llamadas_que_admite_y_las_demas_esperan_su_turno(self):
        for concurrency in (1, 2):
            with self.subTest(concurrency=concurrency):
                limiter = zerochat.RateLimiter()
                policy = zerochat.RatePolicy(concurrency=concurrency)
                inside, peak, lock = [0], [0], threading.Lock()

                def call():
                    with limiter.slot("mcp:demo", policy):
                        with lock:
                            inside[0] += 1
                            peak[0] = max(peak[0], inside[0])
                        time.sleep(0.05)
                        with lock:
                            inside[0] -= 1

                threads = [threading.Thread(target=call) for _ in range(4)]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()
                self.assertEqual(peak[0], concurrency)

    def test_si_el_turno_no_llega_dentro_de_la_espera_admitida_falla_enseguida(self):
        limiter = zerochat.RateLimiter()
        policy = zerochat.RatePolicy(concurrency=1, min_interval_s=0.3)
        # Hace falta esperar 0.3 s: con 0.25 admitidos no espera en vano; con 0.5, sí entra.
        started = time.monotonic()
        with self.assertRaisesRegex(zerochat.RateLimitBusy, "demo está ocupado"), limiter.slot("demo", policy, max_wait_s=0.25):
            pass
        self.assertLess(time.monotonic() - started, 0.1)
        self.assertGreaterEqual(timed(limiter, "demo", policy, max_wait_s=0.5), 0.15)
        # Ocupado por otra llamada más allá de la espera: falla al agotarla.
        with limiter.slot("lleno", zerochat.RatePolicy()), self.assertRaises(zerochat.RateLimitBusy):
            with limiter.slot("lleno", zerochat.RatePolicy(), max_wait_s=0.1):
                pass

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
