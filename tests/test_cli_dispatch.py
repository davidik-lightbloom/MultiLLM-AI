"""Coverage for ensemble_demo.py's CLI subcommand dispatch (main()).

Previously untested: multillm chat/train/corpus/eval delegate to other
modules' own CLIs via runpy (see _delegate's docstring), and the implied
"query" form has to keep working for the pre-existing bare-string and
--sources/--top-k usage. These tests mock _delegate/_run_query rather than
actually running training or a chat REPL.
"""

import ensemble_demo


def _run_main(monkeypatch, argv):
    monkeypatch.setattr(ensemble_demo.sys, "argv", ["multillm", *argv])
    ensemble_demo.main()


def test_help_flag_prints_docstring(monkeypatch, capsys):
    _run_main(monkeypatch, ["--help"])
    assert "multillm CLI" in capsys.readouterr().out


def test_version_flag_prints_version(monkeypatch, capsys):
    _run_main(monkeypatch, ["--version"])
    assert "multillm" in capsys.readouterr().out


def test_chat_delegates_to_ai_client(monkeypatch):
    calls = []
    monkeypatch.setattr(ensemble_demo, "_delegate", lambda module, argv: calls.append((module, argv)))
    _run_main(monkeypatch, ["chat", "--extra-flag"])
    assert calls == [("ai_client", ["--extra-flag"])]


def test_train_delegates_to_train_train(monkeypatch):
    calls = []
    monkeypatch.setattr(ensemble_demo, "_delegate", lambda module, argv: calls.append((module, argv)))
    _run_main(monkeypatch, ["train", "--epochs", "5"])
    assert calls == [("train.train", ["--epochs", "5"])]


def test_corpus_delegates_to_train_dataset(monkeypatch):
    calls = []
    monkeypatch.setattr(ensemble_demo, "_delegate", lambda module, argv: calls.append((module, argv)))
    _run_main(monkeypatch, ["corpus"])
    assert calls == [("train.dataset", [])]


def test_eval_delegates_to_train_eval_generator(monkeypatch):
    calls = []
    monkeypatch.setattr(ensemble_demo, "_delegate", lambda module, argv: calls.append((module, argv)))
    _run_main(monkeypatch, ["eval"])
    assert calls == [("train.eval_generator", [])]


def test_bare_string_is_implied_query(monkeypatch):
    calls = []
    monkeypatch.setattr(ensemble_demo, "_run_query", lambda argv: calls.append(argv))
    _run_main(monkeypatch, ["How does this work?"])
    assert calls == [["How does this work?"]]


def test_flags_without_query_keyword_still_work(monkeypatch):
    calls = []
    monkeypatch.setattr(ensemble_demo, "_run_query", lambda argv: calls.append(argv))
    _run_main(monkeypatch, ["--sources", "--top-k", "3", "question"])
    assert calls == [["--sources", "--top-k", "3", "question"]]


def test_explicit_query_keyword_is_stripped(monkeypatch):
    calls = []
    monkeypatch.setattr(ensemble_demo, "_run_query", lambda argv: calls.append(argv))
    _run_main(monkeypatch, ["query", "--sources", "question"])
    assert calls == [["--sources", "question"]]


def test_no_args_runs_query_with_default_question(monkeypatch):
    calls = []
    monkeypatch.setattr(ensemble_demo, "_run_query", lambda argv: calls.append(argv))
    _run_main(monkeypatch, [])
    assert calls == [[]]
