use std::collections::HashSet;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::{Client, StatusCode};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use serde_json::json;

const OXFORD_BASE_URL: &str = "https://www.oxfordlearnersdictionaries.com/definition/english";
const OXFORD_ORIGIN: &str = "https://www.oxfordlearnersdictionaries.com";
const USER_AGENT: &str = "Mozilla/5.0";
const MAX_CANDIDATE_PAGES: usize = 8;

#[derive(Clone, Debug, Serialize)]
pub struct DictionaryDefinition {
    pub entry_id: String,
    pub word_type: String,
    pub number: usize,
    pub definition: String,
    pub examples: Vec<String>,
    pub source_url: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DictionaryChoice {
    pub entry_id: Option<String>,
    pub definition_number: Option<usize>,
    pub definition: String,
    pub examples: Vec<String>,
    pub ai_explanation: String,
    pub matched: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct DictionaryLookup {
    pub word: String,
    pub selected_word: String,
    pub word_type: String,
    pub cefr_level: String,
    pub phonetics: Vec<String>,
    pub audio_url: String,
    pub source_url: String,
    pub definitions: Vec<DictionaryDefinition>,
    pub context_definition: DictionaryChoice,
    pub simple_meaning: String,
    pub in_context_meaning: String,
    pub original_meaning: String,
}

#[derive(Clone, Debug)]
struct OxfordEntry {
    entry_id: String,
    word: String,
    word_type: String,
    cefr_level: String,
    phonetics: Vec<String>,
    audio_url: String,
    definitions: Vec<DictionaryDefinition>,
}

#[derive(Debug)]
struct FetchedPage {
    html: String,
    source_url: String,
}

#[derive(Debug)]
enum FetchError {
    NotFound,
    Other(anyhow::Error),
}

pub async fn lookup_word(
    word: String,
    context: String,
    cefr_level: String,
    root_word: String,
) -> Result<DictionaryLookup> {
    let selected_word =
        normalize_word(&word).ok_or_else(|| anyhow!("Select one English word to look up."))?;
    let lookup_words = lookup_candidates(&selected_word, &root_word);
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .http1_only()
        .build()
        .context("Unable to create dictionary HTTP client")?;

    let mut last_error = None;
    let mut first_page = None;
    let mut lookup_word = selected_word.clone();
    for candidate in lookup_words {
        match fetch_first_page(&client, &candidate).await {
            Ok(page) => {
                lookup_word = candidate;
                first_page = Some(page);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let first_page = first_page.ok_or_else(|| {
        last_error.unwrap_or_else(|| anyhow!("Oxford lookup failed for {selected_word}."))
    })?;
    let mut urls = candidate_urls(&first_page.html, &first_page.source_url, &lookup_word);
    if urls.is_empty() {
        urls.push(first_page.source_url.clone());
    }

    let mut entries = Vec::new();
    for (index, url) in urls.into_iter().take(MAX_CANDIDATE_PAGES).enumerate() {
        let page = if index == 0 && url == first_page.source_url {
            FetchedPage {
                html: first_page.html.clone(),
                source_url: first_page.source_url.clone(),
            }
        } else {
            match fetch_page(&client, &url).await {
                Ok(page) => page,
                Err(FetchError::NotFound) => continue,
                Err(FetchError::Other(error)) => return Err(error),
            }
        };
        entries.push(parse_oxford_entry(
            &page.html,
            &page.source_url,
            &lookup_word,
        ));
    }

    let definitions = entries
        .iter()
        .flat_map(|entry| entry.definitions.clone())
        .collect::<Vec<_>>();
    if definitions.is_empty() {
        return Err(anyhow!("No Oxford definitions found for {lookup_word}."));
    }

    let choice = choose_definition(&client, &selected_word, &context, &definitions).await;
    let selected_definition = choice
        .entry_id
        .as_ref()
        .and_then(|entry_id| {
            choice.definition_number.and_then(|number| {
                definitions.iter().find(|definition| {
                    definition.entry_id == *entry_id && definition.number == number
                })
            })
        })
        .or_else(|| definitions.first())
        .expect("definitions checked above");
    let selected_entry = entries
        .iter()
        .find(|entry| entry.entry_id == selected_definition.entry_id)
        .or_else(|| entries.first())
        .expect("entries exist when definitions exist");

    let simple_meaning = choice
        .simple_meaning
        .clone()
        .unwrap_or_else(|| selected_definition.definition.clone());
    let in_context_meaning = choice.in_context_meaning.clone().unwrap_or_default();
    let original_meaning = choice.original_meaning.clone().unwrap_or_default();
    let dictionary_choice = choice.into_dictionary_choice(selected_definition);

    Ok(DictionaryLookup {
        word: selected_entry.word.clone(),
        selected_word,
        word_type: selected_entry.word_type.clone(),
        cefr_level: if selected_entry.cefr_level.is_empty() {
            cefr_level
        } else {
            selected_entry.cefr_level.clone()
        },
        phonetics: selected_entry.phonetics.clone(),
        audio_url: selected_entry.audio_url.clone(),
        source_url: selected_definition.source_url.clone(),
        definitions,
        context_definition: dictionary_choice,
        simple_meaning,
        in_context_meaning,
        original_meaning,
    })
}

async fn fetch_first_page(client: &Client, word: &str) -> Result<FetchedPage> {
    let direct_url = format!(
        "{OXFORD_BASE_URL}/{}?q={}",
        encode_component(word),
        encode_component(word)
    );
    match fetch_page(client, &direct_url).await {
        Ok(page) => Ok(page),
        Err(FetchError::NotFound) | Err(FetchError::Other(_)) => {
            let search_url = format!(
                "{OXFORD_ORIGIN}/search/english/direct/?q={}",
                encode_component(word)
            );
            match fetch_page(client, &search_url).await {
                Ok(page) => Ok(page),
                Err(FetchError::NotFound) => Err(anyhow!("Oxford lookup failed.")),
                Err(FetchError::Other(error)) => Err(error),
            }
        }
    }
}

async fn fetch_page(client: &Client, url: &str) -> std::result::Result<FetchedPage, FetchError> {
    let response = client
        .get(url)
        .header(reqwest::header::USER_AGENT, USER_AGENT)
        .send()
        .await
        .map_err(|error| FetchError::Other(anyhow!("Oxford lookup failed: {error}")))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err(FetchError::NotFound);
    }
    if !response.status().is_success() {
        return Err(FetchError::Other(anyhow!(
            "Oxford lookup failed with status {}.",
            response.status()
        )));
    }
    let source_url = response.url().to_string();
    let html = response
        .text()
        .await
        .map_err(|error| FetchError::Other(anyhow!("Unable to read Oxford response: {error}")))?;
    Ok(FetchedPage { html, source_url })
}

fn parse_oxford_entry(html: &str, source_url: &str, fallback_word: &str) -> OxfordEntry {
    let document = Html::parse_document(html);
    let word = first_text(&document, "h1").unwrap_or_else(|| fallback_word.to_string());
    let word_type = first_text(&document, ".pos").unwrap_or_default();
    let cefr_level = extract_cefr_level(&document);
    let phonetics = all_unique_text(&document, ".phon");
    let audio_urls = audio_urls(&document);
    let audio_url = preferred_audio_url(&audio_urls, fallback_word);
    let entry_id = entry_id_from_url(source_url).unwrap_or_else(|| fallback_word.to_string());
    let definitions = parse_definitions(&document, &entry_id, &word_type, source_url);

    OxfordEntry {
        entry_id,
        word,
        word_type,
        cefr_level,
        phonetics,
        audio_url,
        definitions,
    }
}

fn parse_definitions(
    document: &Html,
    entry_id: &str,
    word_type: &str,
    source_url: &str,
) -> Vec<DictionaryDefinition> {
    let sense_selector = Selector::parse(".sense").expect("valid selector");
    let definition_selector = Selector::parse(".def").expect("valid selector");
    let example_selector = Selector::parse(".x").expect("valid selector");
    let mut definitions = Vec::new();
    let mut seen = HashSet::new();

    for sense in document.select(&sense_selector) {
        let Some(definition_node) = sense.select(&definition_selector).next() else {
            continue;
        };
        let definition = clean_text(&definition_node.text().collect::<Vec<_>>().join(" "));
        if definition.is_empty() || !seen.insert(definition.clone()) {
            continue;
        }
        let examples = sense
            .select(&example_selector)
            .map(|node| clean_text(&node.text().collect::<Vec<_>>().join(" ")))
            .filter(|text| !text.is_empty())
            .take(4)
            .collect::<Vec<_>>();
        definitions.push(DictionaryDefinition {
            entry_id: entry_id.to_string(),
            word_type: word_type.to_string(),
            number: definitions.len() + 1,
            definition,
            examples,
            source_url: source_url.to_string(),
        });
    }

    if definitions.is_empty() {
        for definition_node in document.select(&definition_selector) {
            let definition = clean_text(&definition_node.text().collect::<Vec<_>>().join(" "));
            if definition.is_empty() || !seen.insert(definition.clone()) {
                continue;
            }
            definitions.push(DictionaryDefinition {
                entry_id: entry_id.to_string(),
                word_type: word_type.to_string(),
                number: definitions.len() + 1,
                definition,
                examples: Vec::new(),
                source_url: source_url.to_string(),
            });
        }
    }

    definitions
}

#[derive(Debug, Deserialize)]
struct AiDefinitionChoice {
    entry_id: Option<String>,
    definition_number: Option<usize>,
    simple_meaning: Option<String>,
    in_context_meaning: Option<String>,
    original_meaning: Option<String>,
    explanation: Option<String>,
    matched: Option<bool>,
}

impl AiDefinitionChoice {
    fn into_dictionary_choice(self, fallback: &DictionaryDefinition) -> DictionaryChoice {
        let definition_number = self.definition_number;
        let matched = self.matched.unwrap_or(definition_number.is_some());
        let definition = if matched {
            fallback.definition.clone()
        } else {
            self.in_context_meaning
                .clone()
                .or(self.simple_meaning.clone())
                .unwrap_or_else(|| fallback.definition.clone())
        };
        DictionaryChoice {
            entry_id: self.entry_id,
            definition_number,
            definition,
            examples: fallback.examples.clone(),
            ai_explanation: self.explanation.unwrap_or_default(),
            matched,
        }
    }
}

async fn choose_definition(
    client: &Client,
    word: &str,
    context: &str,
    definitions: &[DictionaryDefinition],
) -> AiDefinitionChoice {
    let Some(api_key) = std::env::var("DEEPSEEK_API_KEY")
        .ok()
        .filter(|value| !value.trim().is_empty())
    else {
        return fallback_choice(definitions);
    };
    let model = std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-v4-flash".to_string());
    let candidates = definitions
        .iter()
        .map(|definition| {
            json!({
                "entry_id": definition.entry_id,
                "part_of_speech": definition.word_type,
                "definition_number": definition.number,
                "definition": definition.definition,
                "examples": definition.examples,
                "source_url": definition.source_url,
            })
        })
        .collect::<Vec<_>>();
    let payload = json!({
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": concat!(
                    "Choose the Oxford definition that matches the selected word in context. ",
                    "Candidates may include separate noun and verb Oxford entries for the same spelling. ",
                    "Return compact JSON only with: entry_id, definition_number, simple_meaning, ",
                    "in_context_meaning, original_meaning, explanation, matched. ",
                    "simple_meaning should be plain English. in_context_meaning should explain the word as used here. ",
                    "original_meaning should explain literal, etymological, or idiom-origin meaning only when useful; otherwise use an empty string. ",
                    "Use matched false only when no Oxford definition covers the contextual meaning."
                )
            },
            {
                "role": "user",
                "content": json!({
                    "word": word,
                    "context": context,
                    "candidates": candidates,
                }).to_string()
            }
        ],
        "stream": false,
    });

    let response = client
        .post("https://api.deepseek.com/chat/completions")
        .bearer_auth(api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(payload.to_string())
        .send()
        .await;
    let Ok(response) = response else {
        return fallback_choice(definitions);
    };
    let Ok(body) = response.text().await else {
        return fallback_choice(definitions);
    };
    let Ok(data) = serde_json::from_str::<serde_json::Value>(&body) else {
        return fallback_choice(definitions);
    };
    let Some(content) = data
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
    else {
        return fallback_choice(definitions);
    };
    let Ok(parsed) = serde_json::from_str::<AiDefinitionChoice>(&extract_json(content)) else {
        return fallback_choice(definitions);
    };
    if let (Some(entry_id), Some(number)) = (&parsed.entry_id, parsed.definition_number) {
        if definitions
            .iter()
            .any(|definition| definition.entry_id == *entry_id && definition.number == number)
        {
            return parsed;
        }
    }
    if parsed.matched == Some(false)
        && (parsed
            .in_context_meaning
            .as_deref()
            .unwrap_or_default()
            .trim()
            .len()
            > 3
            || parsed
                .simple_meaning
                .as_deref()
                .unwrap_or_default()
                .trim()
                .len()
                > 3)
    {
        return parsed;
    }
    fallback_choice(definitions)
}

fn fallback_choice(definitions: &[DictionaryDefinition]) -> AiDefinitionChoice {
    let first = definitions.first();
    AiDefinitionChoice {
        entry_id: first.map(|definition| definition.entry_id.clone()),
        definition_number: first.map(|definition| definition.number),
        simple_meaning: first.map(|definition| definition.definition.clone()),
        in_context_meaning: None,
        original_meaning: None,
        explanation: None,
        matched: Some(first.is_some()),
    }
}

fn candidate_urls(html: &str, source_url: &str, word: &str) -> Vec<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("a").expect("valid selector");
    let mut urls = Vec::new();
    let mut seen = HashSet::new();
    push_candidate_url(&mut urls, &mut seen, source_url);

    for link in document.select(&selector) {
        let Some(href) = link.value().attr("href") else {
            continue;
        };
        let Some(url) = absolute_oxford_definition_url(href) else {
            continue;
        };
        let Some(entry_id) = entry_id_from_url(&url) else {
            continue;
        };
        if is_same_headword_entry(&entry_id, word) {
            push_candidate_url(&mut urls, &mut seen, &url);
        }
    }

    urls
}

fn push_candidate_url(urls: &mut Vec<String>, seen: &mut HashSet<String>, url: &str) {
    let canonical = url.split('#').next().unwrap_or(url).to_string();
    if seen.insert(canonical.clone()) {
        urls.push(canonical);
    }
}

fn absolute_oxford_definition_url(href: &str) -> Option<String> {
    let stripped = href.split('#').next().unwrap_or(href);
    if stripped.starts_with("https://www.oxfordlearnersdictionaries.com/definition/english/") {
        Some(stripped.to_string())
    } else if stripped.starts_with("/definition/english/") {
        Some(format!("{OXFORD_ORIGIN}{stripped}"))
    } else {
        None
    }
}

fn entry_id_from_url(url: &str) -> Option<String> {
    let path = url.split('?').next().unwrap_or(url);
    let marker = "/definition/english/";
    let start = path.find(marker)? + marker.len();
    let id = path[start..].split('/').next()?.trim();
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

fn is_same_headword_entry(entry_id: &str, word: &str) -> bool {
    if entry_id == word {
        return true;
    }
    let Some(suffix) = entry_id.strip_prefix(&format!("{word}_")) else {
        return false;
    };
    !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
}

fn first_text(document: &Html, selector: &str) -> Option<String> {
    let selector = Selector::parse(selector).ok()?;
    document
        .select(&selector)
        .map(|node| clean_text(&node.text().collect::<Vec<_>>().join(" ")))
        .find(|text| !text.is_empty())
}

fn all_unique_text(document: &Html, selector: &str) -> Vec<String> {
    let Ok(selector) = Selector::parse(selector) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    document
        .select(&selector)
        .map(|node| clean_text(&node.text().collect::<Vec<_>>().join(" ")))
        .filter(|text| !text.is_empty() && seen.insert(text.clone()))
        .collect()
}

fn extract_cefr_level(document: &Html) -> String {
    let selector = Selector::parse(".belong-to, .symbols").expect("valid selector");
    for node in document.select(&selector) {
        let text = clean_text(&node.text().collect::<Vec<_>>().join(" ")).to_uppercase();
        for level in ["A1", "A2", "B1", "B2", "C1", "C2"] {
            if text
                .split(|character: char| !character.is_ascii_alphanumeric())
                .any(|part| part == level)
            {
                return level.to_string();
            }
        }
    }
    String::new()
}

fn audio_urls(document: &Html) -> Vec<String> {
    let selector = Selector::parse("*").expect("valid selector");
    let mut urls = Vec::new();
    let mut seen = HashSet::new();
    for node in document.select(&selector) {
        for attr in ["data-src-mp3", "src"] {
            let Some(url) = node.value().attr(attr) else {
                continue;
            };
            if url.ends_with(".mp3") && seen.insert(url.to_string()) {
                urls.push(url.to_string());
            }
        }
    }
    urls
}

fn preferred_audio_url(urls: &[String], word: &str) -> String {
    let word = word.to_lowercase();
    urls.iter()
        .find(|url| url.to_lowercase().contains(&format!("/{word}__gb_")))
        .or_else(|| {
            urls.iter()
                .find(|url| url.to_lowercase().contains(&format!("/{word}__")))
        })
        .or_else(|| urls.iter().find(|url| url.to_lowercase().contains("_gb_")))
        .or_else(|| urls.first())
        .cloned()
        .unwrap_or_default()
}

fn lookup_candidates(selected_word: &str, root_word: &str) -> Vec<String> {
    let mut stems = Vec::new();
    let mut candidates = Vec::new();
    if let Some(root) = normalize_word(root_word) {
        if root != selected_word {
            stems.push(root);
        }
    }
    if selected_word.len() > 4 && selected_word.ends_with("ies") {
        stems.push(format!("{}y", &selected_word[..selected_word.len() - 3]));
    }
    if selected_word.len() > 4 && selected_word.ends_with("es") {
        stems.push(selected_word[..selected_word.len() - 2].to_string());
    }
    if selected_word.len() > 3 && selected_word.ends_with('s') && !selected_word.ends_with("ss") {
        stems.push(selected_word[..selected_word.len() - 1].to_string());
    }
    if selected_word.len() > 5 && selected_word.ends_with("ied") {
        stems.push(format!("{}y", &selected_word[..selected_word.len() - 3]));
    }
    if selected_word.len() > 4 && selected_word.ends_with("ed") {
        let stem = &selected_word[..selected_word.len() - 2];
        stems.push(stem.to_string());
        stems.push(format!("{stem}e"));
    }
    if selected_word.len() > 5 && selected_word.ends_with("ing") {
        let stem = &selected_word[..selected_word.len() - 3];
        stems.push(stem.to_string());
        stems.push(format!("{stem}e"));
        if stem.len() > 2 {
            let mut chars = stem.chars().rev();
            if chars.next() == chars.next() {
                stems.push(stem[..stem.len() - 1].to_string());
            }
        }
    }
    candidates.extend(stems);
    candidates.push(selected_word.to_string());
    unique(candidates)
}

fn normalize_word(word: &str) -> Option<String> {
    let mut best = String::new();
    let mut current = String::new();
    for character in word.trim().chars() {
        if character.is_ascii_alphabetic()
            || ((!current.is_empty()) && (character == '\'' || character == '-'))
        {
            current.push(character.to_ascii_lowercase());
        } else {
            if current
                .chars()
                .any(|character| character.is_ascii_alphabetic())
                && current.len() > best.len()
            {
                best = trim_word_joiners(&current).to_string();
            }
            current.clear();
        }
    }
    if current
        .chars()
        .any(|character| character.is_ascii_alphabetic())
        && current.len() > best.len()
    {
        best = trim_word_joiners(&current).to_string();
    }
    if best.is_empty() {
        None
    } else {
        Some(best)
    }
}

fn trim_word_joiners(word: &str) -> &str {
    word.trim_matches(|character| character == '\'' || character == '-')
}

fn clean_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        let character = byte as char;
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
            encoded.push(character);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn extract_json(text: &str) -> String {
    let Some(start) = text.find('{') else {
        return text.to_string();
    };
    let Some(end) = text.rfind('}') else {
        return text.to_string();
    };
    if end < start {
        text.to_string()
    } else {
        text[start..=end].to_string()
    }
}

fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| !value.is_empty() && seen.insert(value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HTML: &str = r#"
      <html>
        <body>
          <h1>answer</h1>
          <span class="pos">noun</span>
          <span class="phon">/ˈɑːnsə(r)/</span>
          <span class="belong-to">A1</span>
          <div data-src-mp3="https://audio.oxforddictionaries.com/en/mp3/answer__gb_1.mp3"></div>
          <a href="/definition/english/answer_1?q=answer">answer noun</a>
          <a href="/definition/english/answer_2?q=answer">answer verb</a>
          <li class="sense">
            <span class="def">something that you say, write or do to react to a question</span>
            <span class="x">I wrote my answer.</span>
          </li>
        </body>
      </html>
    "#;

    #[test]
    fn normalizes_selected_words() {
        assert_eq!(normalize_word(" Answered! "), Some("answered".to_string()));
        assert_eq!(normalize_word("can't"), Some("can't".to_string()));
        assert_eq!(normalize_word("..."), None);
    }

    #[test]
    fn builds_lookup_candidates_for_inflected_words() {
        assert_eq!(
            lookup_candidates("resisting", ""),
            vec!["resist", "resiste", "resisting"]
        );
        assert_eq!(
            lookup_candidates("answered", ""),
            vec!["answer", "answere", "answered"]
        );
    }

    #[test]
    fn collects_same_headword_candidate_urls() {
        let urls = candidate_urls(
            HTML,
            "https://www.oxfordlearnersdictionaries.com/definition/english/answer_1?q=answer",
            "answer",
        );
        assert_eq!(
            urls,
            vec![
                "https://www.oxfordlearnersdictionaries.com/definition/english/answer_1?q=answer",
                "https://www.oxfordlearnersdictionaries.com/definition/english/answer_2?q=answer",
            ]
        );
    }

    #[test]
    fn parses_oxford_like_entry() {
        let entry = parse_oxford_entry(
            HTML,
            "https://www.oxfordlearnersdictionaries.com/definition/english/answer_1?q=answer",
            "answer",
        );
        assert_eq!(entry.entry_id, "answer_1");
        assert_eq!(entry.word, "answer");
        assert_eq!(entry.word_type, "noun");
        assert_eq!(entry.cefr_level, "A1");
        assert_eq!(entry.phonetics, vec!["/ˈɑːnsə(r)/"]);
        assert!(entry.audio_url.contains("answer__gb_1.mp3"));
        assert_eq!(entry.definitions.len(), 1);
        assert_eq!(entry.definitions[0].number, 1);
        assert_eq!(entry.definitions[0].examples, vec!["I wrote my answer."]);
    }

    #[test]
    #[ignore = "hits Oxford Learner's Dictionary"]
    fn live_lookup_resisting_uses_base_oxford_entry() {
        let lookup = tauri::async_runtime::block_on(lookup_word(
            "resisting".to_string(),
            "resisting\n\nShe was resisting the order.".to_string(),
            "".to_string(),
            "".to_string(),
        ))
        .expect("live lookup");

        assert_eq!(lookup.word, "resist");
        assert!(!lookup.definitions.is_empty());
    }

    #[test]
    fn extracts_json_from_model_wrapping() {
        assert_eq!(
            extract_json("```json\n{\"matched\":true}\n```"),
            "{\"matched\":true}"
        );
    }
}
