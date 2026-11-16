import logging

import pytest
from conftest import SECRET

from app.config import DEFAULT_HOST, DEFAULT_PORT, ConfigError, get_settings


def test_defaults_are_local_only_port_8020_and_no_secret():
    s = get_settings({})
    assert (s.host, s.port, s.worker_secret, s.log_level) == (DEFAULT_HOST, DEFAULT_PORT, "", "INFO")
    assert s.host == "127.0.0.1" and s.port == 8020
    assert s.auth_enabled is False


def test_reads_valid_values():
    s = get_settings({"AAIE_WORKER_HOST": "0.0.0.0", "AAIE_WORKER_PORT": "9123", "AAIE_WORKER_SECRET": SECRET, "AAIE_WORKER_LOG_LEVEL": "debug"})
    assert (s.host, s.port, s.log_level) == ("0.0.0.0", 9123, "DEBUG")
    assert s.auth_enabled is True


def test_reads_os_environ_by_default(monkeypatch):
    monkeypatch.setenv("AAIE_WORKER_PORT", "8999")
    assert get_settings().port == 8999


@pytest.mark.parametrize("port", ["0", "65536", "-1", "80a", "8020.5", "  "])
def test_invalid_port_is_rejected(port):
    if port.strip() == "":
        assert get_settings({"AAIE_WORKER_PORT": port}).port == 8020  # blank = default
        return
    with pytest.raises(ConfigError, match="AAIE_WORKER_PORT"):
        get_settings({"AAIE_WORKER_PORT": port})


@pytest.mark.parametrize("host", ["bad host", "host;rm", "a" * 300])
def test_invalid_host_is_rejected(host):
    with pytest.raises(ConfigError, match="AAIE_WORKER_HOST"):
        get_settings({"AAIE_WORKER_HOST": host})


def test_invalid_log_level_is_rejected():
    with pytest.raises(ConfigError, match="AAIE_WORKER_LOG_LEVEL"):
        get_settings({"AAIE_WORKER_LOG_LEVEL": "LOUD"})


@pytest.mark.parametrize("secret", ["short", "has space inside 1234", "x" * 257, "tab\tinside-0123456789"])
def test_weak_or_malformed_secret_is_rejected_without_echoing_it(secret):
    with pytest.raises(ConfigError, match="AAIE_WORKER_SECRET") as exc:
        get_settings({"AAIE_WORKER_SECRET": secret})
    assert secret not in str(exc.value)


def test_secret_never_appears_in_repr_str_or_logs(caplog):
    s = get_settings({"AAIE_WORKER_SECRET": SECRET})
    assert SECRET not in repr(s) and SECRET not in str(s)
    assert "***" in repr(s)
    with caplog.at_level(logging.DEBUG):
        from app.main import create_app

        create_app(s)
        logging.getLogger("aaie_worker").info("settings: %s", s)
    assert SECRET not in caplog.text


def test_ai_settings_have_no_default_model_and_mask_the_key():
    s = get_settings({})
    assert (s.gemini_api_key, s.llm_model, s.llm_timeout_seconds, s.ai_configured) == ("", "", 60.0, False)
    key = "AIzaFAKEKEY0123456789"
    configured = get_settings({"GEMINI_API_KEY": key, "AAIE_LLM_MODEL": "some-model", "AAIE_LLM_TIMEOUT_SECONDS": "30"})
    assert configured.ai_configured and configured.llm_model == "some-model" and configured.llm_timeout_seconds == 30
    assert key not in repr(configured) and key not in str(configured)
    assert get_settings({"GEMINI_API_KEY": key}).ai_configured is False  # a key alone is not enough


@pytest.mark.parametrize(
    ("name", "value"),
    [("AAIE_LLM_TIMEOUT_SECONDS", "0"), ("AAIE_LLM_TIMEOUT_SECONDS", "301"), ("AAIE_LLM_TIMEOUT_SECONDS", "soon"),
     ("AAIE_LLM_MODEL", "bad model name"), ("GEMINI_API_KEY", "has space key")],
)
def test_invalid_ai_settings_are_rejected_without_echoing(name, value):
    with pytest.raises(ConfigError, match=name) as exc:
        get_settings({name: value})
    if len(value) > 3:  # short values like "0" occur naturally in the message ("between 1 and 300")
        assert value not in str(exc.value)


def test_settings_are_immutable():
    s = get_settings({})
    with pytest.raises(AttributeError):
        s.port = 1  # type: ignore[misc]
