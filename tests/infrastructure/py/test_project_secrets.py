"""Pruebas unitarias/infraestructura de secretos por proyecto en SQLite y RPC."""

from pathlib import Path
import unittest

from backend import use_data_dir, zerochat


class ProjectSecretsTest(unittest.TestCase):
    def setUp(self):
        self.data_dir = use_data_dir(self)
        self.proj_dir = self.data_dir / "proj"
        self.proj_dir.mkdir(parents=True)
        self.ctx = zerochat.SecurityContext(self.proj_dir.resolve())

    def test_crud_secretos_por_proyecto_nunca_expone_valores_y_respeta_tope(self):
        res, err, _ = zerochat.dispatch_local("zerochat/project/secrets/list", {}, self.ctx)
        self.assertIsNone(err)
        self.assertEqual(res, {"secrets": []})

        res, err, _ = zerochat.dispatch_local(
            "zerochat/project/secrets/set",
            {"name": "BANCO_PIN", "value": "9876"},
            self.ctx,
        )
        self.assertIsNone(err)
        self.assertEqual(res, {"secrets": ["BANCO_PIN"]})
        self.assertNotIn("9876", str(res))
        self.assertEqual(zerochat.get_project_secret(self.ctx.key, "BANCO_PIN"), "9876")
        # set no borra: un valor nulo es un error y el secreto sigue guardado (para eso está secrets/delete).
        _, err, _ = zerochat.dispatch_local("zerochat/project/secrets/set", {"name": "BANCO_PIN", "value": None}, self.ctx)
        self.assertIsNotNone(err)
        self.assertEqual(zerochat.get_project_secret(self.ctx.key, "BANCO_PIN"), "9876")

        # Otro proyecto no ve este secreto
        other_dir = self.data_dir / "other"
        other_dir.mkdir()
        other_ctx = zerochat.SecurityContext(other_dir.resolve())
        zerochat.save_project_secret(other_ctx.key, "OTRO_PIN", "1111")
        self.assertEqual(zerochat.list_project_secret_names(other_ctx.key), ["OTRO_PIN"])
        self.assertEqual(zerochat.list_project_secret_names(self.ctx.key), ["BANCO_PIN"])

        # Nombres inválidos rechazados
        for bad_name in ("", "1ABC", "a-b", "a:b", "x" * 65, 123):
            _, err, _ = zerochat.dispatch_local(
                "zerochat/project/secrets/set",
                {"name": bad_name, "value": "1234"},
                self.ctx,
            )
            self.assertIsNotNone(err)

        # Borde exacto MAX_PROJECT_SECRETS (N=50 permitido, N+1=51 rechazado)
        for i in range(1, zerochat.MAX_PROJECT_SECRETS):
            zerochat.save_project_secret(self.ctx.key, f"S_{i}", "val")
        self.assertEqual(len(zerochat.list_project_secret_names(self.ctx.key)), zerochat.MAX_PROJECT_SECRETS)
        # Actualizar uno existente al llegar al tope sigue funcionando
        zerochat.save_project_secret(self.ctx.key, "BANCO_PIN", "4321")
        self.assertEqual(zerochat.get_project_secret(self.ctx.key, "BANCO_PIN"), "4321")
        # Añadir el N+1 falla
        _, err, _ = zerochat.dispatch_local(
            "zerochat/project/secrets/set",
            {"name": "EXTRA_51", "value": "val"},
            self.ctx,
        )
        self.assertIsNotNone(err)

        # Borrar uno concreto y borrar todos al borrar el proyecto
        res, err, _ = zerochat.dispatch_local("zerochat/project/secrets/delete", {"name": "BANCO_PIN"}, self.ctx)
        self.assertIsNone(err)
        self.assertNotIn("BANCO_PIN", res["secrets"])

        zerochat.delete_project_storage(self.ctx.key)
        self.assertEqual(zerochat.list_project_secret_names(self.ctx.key), [])
        # El otro proyecto conserva sus secretos
        self.assertEqual(zerochat.get_project_secret(other_ctx.key, "OTRO_PIN"), "1111")

    def test_runner_no_puede_gestionar_secretos_por_rpc(self):
        grant = zerochat.TokenGrant(token="t", kind="runner", date="2026-01-01", created_at=0, run_id="r", conversation_id="c")
        for method in ("zerochat/project/secrets/list", "zerochat/project/secrets/set", "zerochat/project/secrets/delete"):
            self.assertFalse(grant.allows(method, {}))
            self.assertTrue(zerochat.TokenGrant(token="t", kind="remote", date="2026-01-01", created_at=0).allows(method, {}))


if __name__ == "__main__":
    unittest.main()
