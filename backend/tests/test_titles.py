from study.titles import derive_week_title


def test_derive_week_title_strips_code_and_week():
    text = "HY335\nWeek 4: Détente in Europe, Ostpolitik and the CSCE\nDr Jane Smith\n12 March 2025"
    assert derive_week_title(text, ["HY335"]) == "Détente in Europe, Ostpolitik and the CSCE"


def test_derive_week_title_handles_all_caps_shouting():
    text = "HY335 AT1\nWEEK 2: THE OUTBREAK OF THE FIRST WORLD WAR\nAutumn Term 2024"
    assert derive_week_title(text, ["HY335"]) == "The Outbreak of the First World War"


def test_derive_week_title_preserves_acronyms_and_possessives():
    text = "HY335 Lecture 7: HITLER'S WAR AND THE USSR\nLondon School of Economics"
    assert derive_week_title(text, ["HY335"]) == "Hitler's War and the USSR"


def test_derive_week_title_preserves_mixed_case():
    text = "HY248\nLecture 3: The treaties that ended the War\nProfessor John Doe"
    assert derive_week_title(text, ["HY248"]) == "The treaties that ended the War"


def test_derive_week_title_strips_en_and_em_dashes():
    # Lecturer slide with en-dash or em-dash
    text = "HY319 \u2013 Week 5 \u2014 Superpower Detente"
    res = derive_week_title(text, ["HY319"])
    assert res == "Superpower Detente"
    assert "\u2013" not in res and "\u2014" not in res


def test_derive_week_title_returns_none_for_minimal_or_empty_text():
    assert derive_week_title("") is None
    assert derive_week_title("HY335\nWeek 6") is None
    assert derive_week_title("Dr Jane Smith\nj.smith@lse.ac.uk\n14 October 2024") is None
