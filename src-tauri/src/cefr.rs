use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use csv::ReaderBuilder;
use serde::Serialize;

const CEFRJ_VOCABULARY: &str = include_str!("../assets/cefr/cefrj-vocabulary-profile-1.5.csv");
const OCTANOVE_C1C2_VOCABULARY: &str =
    include_str!("../assets/cefr/octanove-vocabulary-profile-c1c2-1.0.csv");
const OXFORD_3000_5000_CEFR: &str = include_str!("../assets/cefr/oxford-3000-5000-cefr.csv");

static OXFORD_PROFILE: LazyLock<HashMap<String, CefrLevel>> =
    LazyLock::new(|| load_profile(CefrProfileSource::Oxford));
static LEGACY_OLP_PROFILE: LazyLock<HashMap<String, CefrLevel>> =
    LazyLock::new(|| load_profile(CefrProfileSource::LegacyOlp));
static OXFORD_3000_A1_WORDS: LazyLock<HashSet<String>> = LazyLock::new(load_oxford_3000_a1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CefrProfileSource {
    Oxford,
    LegacyOlp,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub enum CefrLevel {
    A1,
    A2,
    B1,
    B2,
    C1,
    C2,
}

impl CefrLevel {
    fn rank(self) -> u8 {
        match self {
            Self::A1 => 1,
            Self::A2 => 2,
            Self::B1 => 3,
            Self::B2 => 4,
            Self::C1 => 5,
            Self::C2 => 6,
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_uppercase().as_str() {
            "A1" => Some(Self::A1),
            "A2" => Some(Self::A2),
            "B1" => Some(Self::B1),
            "B2" => Some(Self::B2),
            "C1" => Some(Self::C1),
            "C2" => Some(Self::C2),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ReaderToken {
    pub text: String,
    pub normalized_text: String,
    pub root_text: String,
    pub cefr_level: Option<CefrLevel>,
    pub frequency_level: Option<CefrLevel>,
    pub frequency_count: Option<usize>,
}

pub fn tokenize_text(text: &str) -> Vec<ReaderToken> {
    let mut tokens = Vec::new();
    let mut pending_start: Option<usize> = None;

    for (index, character) in text.char_indices() {
        if is_word_character(character) {
            if pending_start.is_none() {
                pending_start = Some(index);
            }
        } else if let Some(start) = pending_start.take() {
            push_token(&mut tokens, &text[start..index]);
            push_token(&mut tokens, &text[index..index + character.len_utf8()]);
        } else {
            push_token(&mut tokens, &text[index..index + character.len_utf8()]);
        }
    }

    if let Some(start) = pending_start {
        push_token(&mut tokens, &text[start..]);
    }

    tokens
}

pub fn lookup_level(word: &str) -> Option<CefrLevel> {
    lookup_level_with_source(word, CefrProfileSource::Oxford)
}

pub fn lookup_level_with_source(word: &str, source: CefrProfileSource) -> Option<CefrLevel> {
    let normalized = normalize_word_text(word);
    if normalized.is_empty() {
        return None;
    }

    for candidate in lookup_candidates(&normalized) {
        if let Some(level) = profile(source).get(&candidate) {
            return Some(*level);
        }
    }
    Some(CefrLevel::C2)
}

pub fn is_oxford_3000_a1_word(word: &str) -> bool {
    let normalized = normalize_word_text(word);
    if normalized.is_empty() {
        return false;
    }
    lookup_candidates(&normalized)
        .iter()
        .any(|candidate| OXFORD_3000_A1_WORDS.contains(candidate))
}

pub fn frequency_key(word: &str) -> Option<String> {
    let normalized = normalize_word_text(word);
    if normalized.is_empty() {
        return None;
    }
    let candidates = lookup_candidates(&normalized);
    if let Some(candidate) = candidates
        .iter()
        .find(|candidate| OXFORD_3000_A1_WORDS.contains(*candidate))
    {
        return Some(candidate.clone());
    }
    candidates
        .into_iter()
        .filter_map(|candidate| {
            profile(CefrProfileSource::Oxford)
                .get(&candidate)
                .map(|level| (candidate, level.rank()))
        })
        .min_by(|(left_word, left_rank), (right_word, right_rank)| {
            left_rank
                .cmp(right_rank)
                .then_with(|| left_word.len().cmp(&right_word.len()))
                .then_with(|| left_word.cmp(right_word))
        })
        .map(|(candidate, _)| candidate)
        .or_else(|| fallback_frequency_stem(&normalized))
        .or(Some(normalized))
}

fn push_token(tokens: &mut Vec<ReaderToken>, text: &str) {
    if text.is_empty() {
        return;
    }

    let normalized_text = normalize_word_text(text);
    let root_text = root_word(&normalized_text);
    let cefr_level = if normalized_text.is_empty() {
        None
    } else {
        lookup_level(&normalized_text)
    };
    tokens.push(ReaderToken {
        text: text.to_string(),
        normalized_text,
        root_text,
        cefr_level,
        frequency_level: None,
        frequency_count: None,
    });
}

fn profile(source: CefrProfileSource) -> &'static HashMap<String, CefrLevel> {
    match source {
        CefrProfileSource::Oxford => &OXFORD_PROFILE,
        CefrProfileSource::LegacyOlp => &LEGACY_OLP_PROFILE,
    }
}

fn load_profile(source: CefrProfileSource) -> HashMap<String, CefrLevel> {
    let mut profile = HashMap::new();
    match source {
        CefrProfileSource::Oxford => load_profile_csv(&mut profile, OXFORD_3000_5000_CEFR),
        CefrProfileSource::LegacyOlp => {
            load_profile_csv(&mut profile, CEFRJ_VOCABULARY);
            load_profile_csv(&mut profile, OCTANOVE_C1C2_VOCABULARY);
        }
    }
    profile
}

fn load_oxford_3000_a1() -> HashSet<String> {
    profile(CefrProfileSource::Oxford)
        .iter()
        .filter_map(|(word, level)| (*level == CefrLevel::A1).then_some(word.clone()))
        .collect()
}

fn load_profile_csv(profile: &mut HashMap<String, CefrLevel>, source: &str) {
    let mut reader = ReaderBuilder::new().from_reader(source.as_bytes());
    let headers = reader.headers().expect("OLP CEFR CSV headers").clone();
    let headword_index = headers
        .iter()
        .position(|header| header == "headword")
        .expect("OLP CEFR CSV headword column");
    let cefr_index = headers
        .iter()
        .position(|header| header == "CEFR")
        .expect("OLP CEFR CSV CEFR column");

    for record in reader
        .records()
        .map(|record| record.expect("OLP CEFR CSV record"))
    {
        let Some(level) = record.get(cefr_index).and_then(CefrLevel::parse) else {
            continue;
        };
        let Some(headword) = record.get(headword_index) else {
            continue;
        };
        for variant in headword_variants(headword) {
            let replace = profile
                .get(&variant)
                .is_none_or(|previous| level.rank() < previous.rank());
            if replace {
                profile.insert(variant, level);
            }
        }
    }
}

fn headword_variants(headword: &str) -> Vec<String> {
    unique(
        headword
            .replace('’', "'")
            .split('/')
            .map(normalize_word_text)
            .collect(),
    )
}

fn lookup_candidates(word: &str) -> Vec<String> {
    let mut candidates = vec![word.to_string(), root_word(word)];

    if let Some(root) = contraction_root(word) {
        candidates.push(root.to_string());
    }
    if let Some(root) = irregular_root(word) {
        candidates.push(root.to_string());
    }
    if let Some((base, suffix)) = word.split_once('\'') {
        candidates.push(base.to_string());
        match suffix {
            "m" | "re" | "s" => candidates.push("be".to_string()),
            "d" => candidates.extend(["would".to_string(), "have".to_string()]),
            "ll" => candidates.push("will".to_string()),
            "ve" => candidates.push("have".to_string()),
            _ => {}
        }
    }
    if word.len() > 4 && word.ends_with("ies") {
        candidates.push(format!("{}y", &word[..word.len() - 3]));
    }
    if word.len() > 4 && word.ends_with("es") {
        candidates.push(word[..word.len() - 2].to_string());
    }
    if word.len() > 3 && word.ends_with('s') && !word.ends_with("ss") {
        candidates.push(word[..word.len() - 1].to_string());
    }
    if word.len() > 5 && word.ends_with("ied") {
        candidates.push(format!("{}y", &word[..word.len() - 3]));
    }
    if word.len() > 4 && word.ends_with("ed") {
        let stem = &word[..word.len() - 2];
        candidates.push(stem.to_string());
        candidates.push(format!("{stem}e"));
    }
    if word.len() > 5 && word.ends_with("ing") {
        let stem = &word[..word.len() - 3];
        candidates.push(stem.to_string());
        candidates.push(format!("{stem}e"));
        if stem.len() > 2 {
            let mut chars = stem.chars().rev();
            if chars.next() == chars.next() {
                candidates.push(stem[..stem.len() - 1].to_string());
            }
        }
    }
    if word.len() > 4 && word.ends_with("er") {
        candidates.push(word[..word.len() - 2].to_string());
    }
    if word.len() > 5 && word.ends_with("est") {
        candidates.push(word[..word.len() - 3].to_string());
    }

    unique(candidates)
}

fn root_word(word: &str) -> String {
    let normalized = normalize_word_text(word);
    if normalized.len() > 4 && normalized.ends_with("ied") {
        return format!("{}y", &normalized[..normalized.len() - 3]);
    }
    normalized
}

fn fallback_frequency_stem(word: &str) -> Option<String> {
    if word.len() > 4 && word.ends_with("ied") {
        return Some(format!("{}y", &word[..word.len() - 3]));
    }
    if word.len() > 4 && word.ends_with("ed") {
        let stem = &word[..word.len() - 2];
        if stem.ends_with('g') || stem.ends_with('v') || stem.ends_with('z') {
            return Some(format!("{stem}e"));
        }
        return Some(stem.to_string());
    }
    if word.len() > 5 && word.ends_with("ing") {
        let stem = &word[..word.len() - 3];
        if stem.len() > 2 {
            let mut chars = stem.chars().rev();
            if chars.next() == chars.next() {
                return Some(stem[..stem.len() - 1].to_string());
            }
        }
        if stem.ends_with('g') || stem.ends_with('v') || stem.ends_with('z') {
            return Some(format!("{stem}e"));
        }
        return Some(stem.to_string());
    }
    if word.len() > 4 && word.ends_with("es") {
        return Some(word[..word.len() - 2].to_string());
    }
    if word.len() > 3 && word.ends_with('s') && !word.ends_with("ss") {
        return Some(word[..word.len() - 1].to_string());
    }
    None
}

fn normalize_word_text(text: &str) -> String {
    let normalized = text.trim().replace('’', "'").to_ascii_lowercase();
    if normalized.is_empty()
        || !normalized
            .chars()
            .any(|character| character.is_ascii_alphanumeric())
        || !normalized.chars().all(is_word_character)
    {
        return String::new();
    }
    normalized
}

fn is_word_character(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '\'' | '-' | '’')
}

fn unique(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .filter(|value| !value.is_empty())
        .fold(Vec::new(), |mut unique, value| {
            if !unique.contains(&value) {
                unique.push(value);
            }
            unique
        })
}

fn contraction_root(word: &str) -> Option<&'static str> {
    match word {
        "aren't" => Some("be"),
        "can't" => Some("can"),
        "couldn't" => Some("could"),
        "didn't" => Some("do"),
        "doesn't" => Some("do"),
        "don't" => Some("do"),
        "hadn't" => Some("have"),
        "hasn't" => Some("have"),
        "haven't" => Some("have"),
        "he'd" => Some("he"),
        "he'll" => Some("he"),
        "he's" => Some("he"),
        "i'd" => Some("i"),
        "i'll" => Some("i"),
        "i'm" => Some("i"),
        "i've" => Some("i"),
        "isn't" => Some("be"),
        "it'd" => Some("it"),
        "it'll" => Some("it"),
        "it's" => Some("it"),
        "she'd" => Some("she"),
        "she'll" => Some("she"),
        "she's" => Some("she"),
        "shouldn't" => Some("should"),
        "that's" => Some("that"),
        "they'd" => Some("they"),
        "they'll" => Some("they"),
        "they're" => Some("they"),
        "they've" => Some("they"),
        "wasn't" => Some("be"),
        "we'd" => Some("we"),
        "we'll" => Some("we"),
        "we're" => Some("we"),
        "we've" => Some("we"),
        "weren't" => Some("be"),
        "won't" => Some("will"),
        "wouldn't" => Some("would"),
        "you'd" => Some("you"),
        "you'll" => Some("you"),
        "you're" => Some("you"),
        "you've" => Some("you"),
        _ => None,
    }
}

fn irregular_root(word: &str) -> Option<&'static str> {
    match word {
        "am" => Some("be"),
        "are" => Some("be"),
        "been" => Some("be"),
        "came" => Some("come"),
        "did" => Some("do"),
        "done" => Some("do"),
        "gone" => Some("go"),
        "got" => Some("get"),
        "had" => Some("have"),
        "held" => Some("hold"),
        "is" => Some("be"),
        "knew" => Some("know"),
        "known" => Some("know"),
        "made" => Some("make"),
        "met" => Some("meet"),
        "said" => Some("say"),
        "saw" => Some("see"),
        "seen" => Some("see"),
        "told" => Some("tell"),
        "was" => Some("be"),
        "went" => Some("go"),
        "were" => Some("be"),
        "written" => Some("write"),
        "wrote" => Some("write"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_oxford_3000_a1_word, lookup_level, lookup_level_with_source, tokenize_text, CefrLevel,
        CefrProfileSource,
    };

    #[test]
    fn looks_up_direct_words() {
        assert_eq!(lookup_level("world"), Some(CefrLevel::A1));
    }

    #[test]
    fn looks_up_slash_variants() {
        assert_eq!(lookup_level("analyse"), Some(CefrLevel::B1));
    }

    #[test]
    fn preserves_legacy_olp_profile() {
        assert_eq!(lookup_level("apparently"), Some(CefrLevel::B2));
        assert_eq!(
            lookup_level_with_source("apparently", CefrProfileSource::LegacyOlp),
            Some(CefrLevel::A2)
        );
    }

    #[test]
    fn looks_up_contractions() {
        assert_eq!(lookup_level("can't"), Some(CefrLevel::A1));
    }

    #[test]
    fn looks_up_irregular_roots() {
        assert_eq!(lookup_level("went"), Some(CefrLevel::A1));
    }

    #[test]
    fn looks_up_inflections() {
        assert_eq!(lookup_level("abilities"), Some(CefrLevel::A2));
        assert_eq!(lookup_level("walked"), Some(CefrLevel::A1));
        assert_eq!(lookup_level("running"), Some(CefrLevel::A2));
    }

    #[test]
    fn ignores_punctuation_and_whitespace() {
        assert_eq!(lookup_level(","), None);
        assert_eq!(lookup_level("'"), None);
        assert_eq!(lookup_level("-"), None);
        assert_eq!(lookup_level("  "), None);
    }

    #[test]
    fn treats_unknown_words_as_c2() {
        assert_eq!(lookup_level("flibbertigibbet"), Some(CefrLevel::C2));
    }

    #[test]
    fn recognizes_oxford_3000_a1_words() {
        assert!(is_oxford_3000_a1_word("the"));
        assert!(is_oxford_3000_a1_word("running"));
        assert!(is_oxford_3000_a1_word("working"));
        assert!(!is_oxford_3000_a1_word("flibbertigibbet"));
    }

    #[test]
    fn maps_inflections_to_known_frequency_keys() {
        assert_eq!(super::frequency_key("working").as_deref(), Some("work"));
        assert_eq!(super::frequency_key("worked").as_deref(), Some("work"));
        assert_eq!(super::frequency_key("works").as_deref(), Some("work"));
        assert_eq!(super::frequency_key("entered").as_deref(), Some("enter"));
        assert_eq!(super::frequency_key("entering").as_deref(), Some("enter"));
        assert_eq!(super::frequency_key("engaged").as_deref(), Some("engaged"));
        assert_eq!(super::frequency_key("engaging").as_deref(), Some("engage"));
    }

    #[test]
    fn tokenization_preserves_source_text() {
        let text = "World, can't stop running.";
        let rendered = tokenize_text(text)
            .into_iter()
            .map(|token| token.text)
            .collect::<String>();
        assert_eq!(rendered, text);
    }
}
