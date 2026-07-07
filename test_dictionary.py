from app.dictionary import fallback_choice, parse_oxford_html


def test_parse_oxford_html() -> None:
    html = """
    <h1>curious</h1>
    <span class="pos">adjective</span>
    <span class="belong-to">B2</span>
    <span class="phon">/x/</span>
    <div data-src-mp3="https://example.com/curious__gb_1.mp3"></div>
    <span class="def">having a strong desire to know about something</span>
    <span class="x">He is such a curious boy.</span>
    """
    entry = parse_oxford_html(html, "https://example.com", "curious")
    assert entry["word"] == "curious"
    assert entry["word_type"] == "adjective"
    assert entry["cefr_level"] == "B2"
    assert entry["phonetics"] == ["/x/"]
    assert entry["audio_url"].endswith("_gb_1.mp3")
    assert entry["definitions"][0]["examples"] == ["He is such a curious boy."]


def test_fallback_choice_uses_oxford_definition() -> None:
    choice = fallback_choice([{"number": 2, "definition": "strange and unusual", "examples": ["Curious."]}])
    assert choice["definition_number"] == 2
    assert choice["definition"] == "strange and unusual"
    assert choice["matched"] is True


if __name__ == "__main__":
    test_parse_oxford_html()
    test_fallback_choice_uses_oxford_definition()
