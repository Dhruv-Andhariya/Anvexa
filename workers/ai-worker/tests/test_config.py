from pathlib import Path

from ai_worker import config


def test_repo_root_is_found_from_any_start_dir():
    root = config.find_repo_root()
    assert (root / "pnpm-workspace.yaml").is_file()
    assert config.find_repo_root(root / "workers" / "ai-worker" / "tests") == root


def test_prompts_dir_defaults_to_repo_prompts(monkeypatch):
    monkeypatch.delenv("PROMPTS_DIR", raising=False)
    assert (config.get_settings().prompts_dir / "jd_generate.v2.yaml").is_file()


def test_env_file_loads_without_overriding_real_env(monkeypatch, tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text("HF_TEST_FROM_FILE=file\nHF_TEST_PRESET=file\n", encoding="utf-8")
    monkeypatch.setenv("HIREFLOW_ENV_FILE", str(env_file))
    monkeypatch.setenv("HF_TEST_PRESET", "process")
    monkeypatch.delenv("HF_TEST_FROM_FILE", raising=False)
    config.load_env.cache_clear()
    try:
        assert config.load_env() == env_file
        import os

        assert os.environ["HF_TEST_FROM_FILE"] == "file"
        assert os.environ["HF_TEST_PRESET"] == "process"
    finally:
        monkeypatch.delenv("HF_TEST_FROM_FILE", raising=False)
        config.load_env.cache_clear()


def test_settings_repr_hides_key(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "super-secret-value")
    assert "super-secret-value" not in repr(config.get_settings())
