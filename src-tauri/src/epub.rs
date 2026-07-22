use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use roxmltree::Document;
use scraper::{ElementRef, Html, Selector};
use zip::ZipArchive;

pub struct ExtractedBook {
    pub title: String,
    pub author: String,
    pub cover: Option<ExtractedCover>,
    pub chapters: Vec<ExtractedChapter>,
}

pub struct ExtractedCover {
    pub path: String,
    pub bytes: Vec<u8>,
}

pub struct ExtractedChapter {
    pub title: String,
    pub source_href: String,
    pub blocks: Vec<ExtractedBlock>,
}

pub struct ExtractedBlock {
    pub kind: ExtractedBlockKind,
    pub text: String,
    pub asset_path: Option<String>,
    pub alt: String,
}

#[derive(Clone, Copy)]
pub enum ExtractedBlockKind {
    Paragraph,
    Image,
}

#[derive(Clone)]
struct ManifestItem {
    id: String,
    href: String,
    media_type: String,
    properties: String,
}

pub fn read_epub(path: &Path) -> Result<ExtractedBook> {
    let file = File::open(path)?;
    let mut zip = ZipArchive::new(file)?;
    let container = read_zip_text(&mut zip, "META-INF/container.xml")?;
    let container_doc = Document::parse(&container)?;
    let opf_path = container_doc
        .descendants()
        .find(|node| node.tag_name().name() == "rootfile")
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| anyhow!("EPUB container is missing the OPF rootfile."))?
        .to_string();
    let opf = read_zip_text(&mut zip, &opf_path)?;
    let opf_doc = Document::parse(&opf)?;
    let opf_base = zip_dirname(&opf_path);

    let title = metadata_text(&opf_doc, "title")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("Book")
                .to_string()
        });
    let author = metadata_text(&opf_doc, "creator").unwrap_or_default();
    let manifest = read_manifest(&opf_doc);
    let manifest_by_id: HashMap<String, ManifestItem> = manifest
        .iter()
        .cloned()
        .map(|item| (item.id.clone(), item))
        .collect();
    let toc_labels = read_toc_labels(&mut zip, &opf_base, &manifest).unwrap_or_default();
    let cover = find_cover(&mut zip, &opf_base, &opf_doc, &manifest, &manifest_by_id);

    let mut chapters = Vec::new();
    for itemref in opf_doc
        .descendants()
        .filter(|node| node.tag_name().name() == "itemref")
    {
        let Some(idref) = itemref.attribute("idref") else {
            continue;
        };
        let Some(item) = manifest_by_id.get(idref) else {
            continue;
        };
        if !looks_like_html(&item.href, &item.media_type) {
            continue;
        }
        let source_href = normalize_zip_path(&item.href);
        let zip_path = join_zip_path(&opf_base, &item.href);
        let content = read_zip_text(&mut zip, &zip_path)
            .with_context(|| format!("Unable to read chapter {}", item.href))?;
        let blocks = parse_chapter_blocks(&content, &zip_dirname(&zip_path));
        if blocks.is_empty() {
            continue;
        }
        let title = toc_labels
            .get(&source_href)
            .cloned()
            .unwrap_or_else(|| fallback_chapter_title(&source_href, chapters.len()));
        chapters.push(ExtractedChapter {
            title,
            source_href,
            blocks,
        });
    }

    Ok(ExtractedBook {
        title: normalize_text(&title).unwrap_or_else(|| "Book".to_string()),
        author: normalize_text(&author).unwrap_or_default(),
        cover,
        chapters,
    })
}

pub fn read_chapter_blocks(path: &Path, source_href: &str) -> Result<Vec<ExtractedBlock>> {
    let file = File::open(path)?;
    let mut zip = ZipArchive::new(file)?;
    let zip_path = find_zip_entry(&mut zip, source_href)
        .ok_or_else(|| anyhow!("Unable to find chapter {source_href} in EPUB."))?;
    let content = read_zip_text(&mut zip, &zip_path)?;
    Ok(parse_chapter_blocks(&content, &zip_dirname(&zip_path)))
}

pub fn read_asset_bytes(path: &Path, asset_path: &str) -> Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut zip = ZipArchive::new(file)?;
    let zip_path = find_zip_entry(&mut zip, asset_path)
        .ok_or_else(|| anyhow!("Unable to find asset {asset_path} in EPUB."))?;
    read_zip_bytes(&mut zip, &zip_path)
}

fn read_zip_text(zip: &mut ZipArchive<File>, path: &str) -> Result<String> {
    let mut file = zip.by_name(path)?;
    let mut content = String::new();
    file.read_to_string(&mut content)?;
    Ok(content)
}

fn read_zip_bytes(zip: &mut ZipArchive<File>, path: &str) -> Result<Vec<u8>> {
    let mut file = zip.by_name(path)?;
    let mut content = Vec::new();
    file.read_to_end(&mut content)?;
    Ok(content)
}

fn find_zip_entry(zip: &mut ZipArchive<File>, source_href: &str) -> Option<String> {
    let normalized = normalize_zip_path(source_href);
    zip.file_names()
        .find(|path| {
            let candidate = normalize_zip_path(path);
            candidate == normalized || candidate.ends_with(&format!("/{normalized}"))
        })
        .map(ToString::to_string)
}

fn metadata_text(doc: &Document<'_>, name: &str) -> Option<String> {
    doc.descendants()
        .find(|node| node.tag_name().name() == name)
        .and_then(|node| node.text())
        .and_then(normalize_text)
}

fn read_manifest(doc: &Document<'_>) -> Vec<ManifestItem> {
    doc.descendants()
        .filter(|node| node.tag_name().name() == "item")
        .map(|node| ManifestItem {
            id: node.attribute("id").unwrap_or_default().to_string(),
            href: node.attribute("href").unwrap_or_default().to_string(),
            media_type: node.attribute("media-type").unwrap_or_default().to_string(),
            properties: node.attribute("properties").unwrap_or_default().to_string(),
        })
        .filter(|item| !item.id.is_empty() && !item.href.is_empty())
        .collect()
}

fn read_toc_labels(
    zip: &mut ZipArchive<File>,
    opf_base: &str,
    manifest: &[ManifestItem],
) -> Result<HashMap<String, String>> {
    let Some(ncx) = manifest
        .iter()
        .find(|item| item.media_type == "application/x-dtbncx+xml")
    else {
        return Ok(HashMap::new());
    };
    let toc_path = join_zip_path(opf_base, &ncx.href);
    let toc_base = zip_dirname(&toc_path);
    let content = read_zip_text(zip, &toc_path)?;
    let doc = Document::parse(&content)?;
    let mut labels = HashMap::new();
    for nav_point in doc
        .descendants()
        .filter(|node| node.tag_name().name() == "navPoint")
    {
        let label = nav_point
            .descendants()
            .find(|node| node.tag_name().name() == "text")
            .and_then(|node| node.text())
            .and_then(normalize_text);
        let src = nav_point
            .descendants()
            .find(|node| node.tag_name().name() == "content")
            .and_then(|node| node.attribute("src"));
        if let (Some(label), Some(src)) = (label, src) {
            let no_fragment = src.split('#').next().unwrap_or(src);
            let absolute = join_zip_path(&toc_base, no_fragment);
            let source_href = strip_base(&absolute, opf_base);
            labels.insert(source_href, label);
        }
    }
    Ok(labels)
}

fn find_cover(
    zip: &mut ZipArchive<File>,
    opf_base: &str,
    doc: &Document<'_>,
    manifest: &[ManifestItem],
    manifest_by_id: &HashMap<String, ManifestItem>,
) -> Option<ExtractedCover> {
    let metadata_cover_id = doc
        .descendants()
        .find(|node| {
            node.tag_name().name() == "meta"
                && node
                    .attribute("name")
                    .is_some_and(|value| value.eq_ignore_ascii_case("cover"))
        })
        .and_then(|node| node.attribute("content"));
    let candidates = [
        metadata_cover_id.and_then(|id| manifest_by_id.get(id)),
        manifest.iter().find(|item| {
            item.properties
                .split_whitespace()
                .any(|value| value == "cover-image")
        }),
        manifest.iter().find(|item| {
            item.href.to_lowercase().contains("cover") && item.media_type.starts_with("image/")
        }),
        manifest
            .iter()
            .find(|item| item.media_type.starts_with("image/")),
    ];

    for candidate in candidates.into_iter().flatten() {
        let path = join_zip_path(opf_base, &candidate.href);
        if let Ok(bytes) = read_zip_bytes(zip, &path) {
            return Some(ExtractedCover { path, bytes });
        }
    }
    None
}

fn parse_chapter_blocks(content: &str, chapter_base: &str) -> Vec<ExtractedBlock> {
    let document = Html::parse_document(content);
    let selector =
        Selector::parse("p, div, li, h1, h2, h3, h4, img").expect("valid chapter block selector");
    document
        .select(&selector)
        .filter(|element| !is_redundant_container(element))
        .filter_map(|element| parse_chapter_block(element, chapter_base))
        .collect()
}

fn parse_chapter_block(element: ElementRef<'_>, chapter_base: &str) -> Option<ExtractedBlock> {
    if element.value().name() == "img" {
        let source = element.value().attr("src")?;
        return Some(ExtractedBlock {
            kind: ExtractedBlockKind::Image,
            text: String::new(),
            asset_path: Some(join_zip_path(chapter_base, source)),
            alt: element
                .value()
                .attr("alt")
                .unwrap_or_default()
                .trim()
                .to_string(),
        });
    }

    normalize_text(&element.text().collect::<Vec<_>>().join(" ")).map(|text| ExtractedBlock {
        kind: ExtractedBlockKind::Paragraph,
        text,
        asset_path: None,
        alt: String::new(),
    })
}

fn is_redundant_container(element: &ElementRef<'_>) -> bool {
    if element.value().name() != "div" {
        return false;
    }
    has_readable_descendant(element)
}

fn has_readable_descendant(element: &ElementRef<'_>) -> bool {
    element.children().any(|child| {
        ElementRef::wrap(child).is_some_and(|child_element| {
            matches!(
                child_element.value().name(),
                "p" | "li" | "h1" | "h2" | "h3" | "h4" | "img"
            ) || has_readable_descendant(&child_element)
        })
    })
}

fn looks_like_html(href: &str, media_type: &str) -> bool {
    media_type.contains("html") || href.ends_with(".xhtml") || href.ends_with(".html")
}

fn normalize_text(value: &str) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn fallback_chapter_title(source_href: &str, index: usize) -> String {
    let stem = source_href
        .rsplit('/')
        .next()
        .and_then(|value| value.split('.').next())
        .unwrap_or_default()
        .replace('_', " ")
        .replace('-', " ");
    normalize_text(&stem)
        .map(title_case)
        .unwrap_or_else(|| format!("Chapter {}", index + 1))
}

fn title_case(value: String) -> String {
    value
        .split_whitespace()
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn zip_dirname(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(dir, _)| dir.to_string())
        .unwrap_or_default()
}

fn join_zip_path(base: &str, path: &str) -> String {
    if base.is_empty() {
        normalize_zip_path(path)
    } else {
        normalize_zip_path(&format!("{base}/{path}"))
    }
}

fn strip_base(path: &str, base: &str) -> String {
    if base.is_empty() {
        normalize_zip_path(path)
    } else {
        path.strip_prefix(&format!("{base}/"))
            .map(normalize_zip_path)
            .unwrap_or_else(|| normalize_zip_path(path))
    }
}

fn normalize_zip_path(path: &str) -> String {
    let mut parts = Vec::new();
    let normalized = path.replace('\\', "/");
    for part in normalized.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_zip_paths() {
        assert_eq!(
            normalize_zip_path("OPS/Text/../Images/cover.jpg"),
            "OPS/Images/cover.jpg"
        );
        assert_eq!(
            normalize_zip_path("./chapter\\one.xhtml"),
            "chapter/one.xhtml"
        );
    }

    #[test]
    fn parses_readable_paragraph_blocks_without_duplicate_wrapper_divs() {
        let blocks = parse_chapter_blocks(
            r#"
            <html><body>
              <div><p>First paragraph.</p><p>Second paragraph.</p></div>
              <div>Loose paragraph in a div.</div>
            </body></html>
            "#,
            "",
        );
        let texts = blocks
            .into_iter()
            .map(|block| block.text)
            .collect::<Vec<_>>();
        assert_eq!(
            texts,
            vec![
                "First paragraph.",
                "Second paragraph.",
                "Loose paragraph in a div."
            ]
        );
    }

    #[test]
    fn skips_deep_wrapper_divs_around_chapter_content() {
        let blocks = parse_chapter_blocks(
            r#"
            <html><body>
              <div class="galley"><section><h1>4</h1><p>First paragraph.</p><p>Second paragraph.</p></section></div>
            </body></html>
            "#,
            "",
        );
        let texts = blocks
            .into_iter()
            .map(|block| block.text)
            .collect::<Vec<_>>();
        assert_eq!(texts, vec!["4", "First paragraph.", "Second paragraph."]);
    }

    #[test]
    fn resolves_image_paths_against_the_chapter_directory() {
        let blocks = parse_chapter_blocks(
            r#"<html><body><img src="../Images/plate01.jpg" alt="Plate"></body></html>"#,
            "OPS/Text",
        );

        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0].kind, ExtractedBlockKind::Image));
        assert_eq!(
            blocks[0].asset_path.as_deref(),
            Some("OPS/Images/plate01.jpg")
        );
        assert_eq!(blocks[0].alt, "Plate");
    }
}
