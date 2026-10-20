# Reading Quality Investigation: Chicago References and Text Reflow

This report summarises the read-only investigation across the live library corpus (`108` PDF readings, `3,131` pages, `1,515,384` words). No reading titles or reading text appear in this file; all cached PDFs, reflow outputs, and the hand-checkable golden evaluation set live in `backend/audit/` (which Git ignores).

---

## 1. The Corpus

Using `backend/tools/identify_audit.py` and `backend/tools/corpus_survey.py` with `api_from_env()` in read-only mode:

- **Total active non-slide PDF readings downloaded and cached in `backend/audit/pdfs`**: `108`
- **Total pages across all `108` PDFs**: `3,131`
- **Total reflowed body words**: `1,515,384`
- **Current `text_status` in the database**: `93` `ready`, `15` `ocr_done`, `0` `ocr_needed`

---

## 2. Document Classification (`n = 108`)

### 2.1 Origin and Text Layer

| Origin | Count | Share | Notes |
| --- | ---: | ---: | --- |
| Born-digital | 65 | 60.2% | Native vector typeset fonts (`text_status = ready`). |
| Scan with an OCR layer | 43 | 39.8% | `15` processed by the laptop processor (`OCRmyPDF` / Tesseract `GlyphLessFont`), plus `28` with publisher or archive OCR layers (JSTOR, CLA/British Library, older digitised scans). |
| Scan with no text | 0 | 0.0% | Every PDF in the corpus currently has a text layer (minimum `~190` words per body page). |

### 2.2 Provider or Cover Sheet

| Provider / Cover Sheet | Count | Share | Notes |
| --- | ---: | ---: | --- |
| Wilson Center Digital Archive or another document collection | 18 | 16.7% | `16` Wilson Center / Cold War International History Project (CWIHP), `2` *Foreign Relations of the United States* (FRUS), plus `5` from other online primary collections (Marxists Internet Archive, Margaret Thatcher Foundation, CVCE, American Presidency Project, OSCE; `23` total archival collection documents). |
| JSTOR | 16 | 14.8% | `12` journal article cover sheets (`Author(s):` / `Source:`) and `4` JSTOR Books chapter cover sheets (`Book Title:` / `Chapter Title:`) without a CLA cover. |
| Cambridge | 13 | 12.0% | Cambridge Core (`10.1017`) cover sheet or margin/footer download stamp (`6` journal articles, `7` edited-volume chapters). |
| Oxford | 9 | 8.3% | Oxford Academic / Oxford Scholarship Online (`10.1093`, `Online ISBN:` / `Print ISBN:`). |
| Taylor & Francis | 8 | 7.4% | Taylor & Francis (`To cite this article:` cover sheet, `tandfonline.com`, `10.1080`). Another `3` Taylor & Francis journal articles arrive via JSTOR cover sheets. |
| LSE or CLA digitisation sheet | 6 | 5.6% | `5` structured Copyright Licensing Agency (CLA) Higher Education Licence cover sheets (`Course of study:`, `Extract title:`, `Book title:`, `ISBN:`, `Publisher:`, `Page range:`) and `1` British Library / LSE digitised copy notice. |
| Other | 38 | 35.2% | `20` ProQuest Ebook Central chapters/books (`Created from lse on ... ProQuest Ebook Central`), `1` HeinOnline, `1` SAGE/Arnold (`10.1191`), `5` small online primary source sites, and `11` plain scans or direct uploads without a provider cover sheet. |

### 2.3 Kind of Work

| Kind of Work | Count | Share | Notes |
| --- | ---: | ---: | --- |
| Book chapter | 48 | 44.4% | `42` have `in ...` in `source`, plus `6` chapters from Oxford Scholarship Online, ProQuest, or JSTOR Books whose `source` is currently blank. (`2` chapters are inside full-book PDFs of `69` and `160` pages where the user recorded the chapter's page range.) |
| Journal article | 28 | 25.9% | Includes `1` full journal issue PDF (`01a116c7-1c15-713e-8541-12891f6d654c`, `194` pages) where the user recorded the article's page range (`453-78`). |
| Primary source | 26 | 24.1% | `24` have `kind = primary` in the database, plus `2` primary source document compilations (`01a116c7-1c17-75fc-af7d-35f4467283b1` and `01a15a54-cf0e-76bd-8353-f9b8a49d4d48`) uploaded with default `kind = secondary`. |
| Book | 6 | 5.6% | Whole monographs, edited volumes, or course guides (`61` to `185` pages) with no single-chapter page range. |

### 2.4 Columns and Page Geometry

| Layout | Count | Share | Notes |
| --- | ---: | ---: | --- |
| Single column (`1 col`) | 101 | 93.5% | Standard single-column pages. |
| Two columns (`2 col`) | 5 | 4.6% | Multi-column journal articles or archival prints (`>= 2` pages with two text columns). |
| Two-page landscape spread (`2-up`) | 2 | 1.9% | Scanned books (`01a15667-22fb-7289-aa8f-d9769cec97a8` and `01a15a9e-e22f-711d-ad93-cc88d0d2862a`) with two facing book pages on each landscape PDF page. |

### 2.5 Footnotes

| Metric | Count |
| --- | ---: |
| Readings containing bottom-of-page footnotes | 68 / 108 (63.0%) |
| Total footnote blocks classified as `"footnote"` by `reflow.ts` today | 1,642 |
| Additional footnote paragraphs leaked into `"para"` body blocks today | 2,665 |

### 2.6 Watermarks, Rotated Stamps, Faint Text, and Repeated Edge Text

| Watermark / Stamp Type | Readings | Notes |
| --- | ---: | --- |
| Rotated text spans (vertical margin stamps or diagonal watermarks) | 17 | Vertical download stamps along the left or right margin (Oxford Academic, JSTOR, Taylor & Francis). `reflow.ts` ignores transformation matrix rotation (`item.transform[0..3]`), sorting each character or line into the body wherever its `y` coordinate falls. |
| Faint / light-grey text spans | 3 | Light-grey watermarks or stamped identifiers. |
| Repeated edge text (running heads, footers, or download stamps on `>= 3` pages) | 94 | Includes `20` ProQuest Ebook Central multi-line copyright footers (`115-160` chars), `13` Cambridge Core footers (`85-130` chars), and `9` Oxford download footers (`80-120` chars) that exceed the length cap in `reflow.ts` (`len < 70` / `len < 110`) and therefore leak into the body text on every page. |

### 2.7 Language

| Language Profile | Readings | Notes |
| --- | ---: | --- |
| Primary language: English | 108 | All `108` readings are primarily in English. |
| Substantial French or German passages / terminology (`> 20` unique FR/DE words not in English) | 28 | Includes diplomatic history readings with French and German quotations, archival titles, and terms (peaking at `1,304` French and `138` German tokens in `01a15b3f-70cb-730e-9eb2-117d5228e2e6`, and `200` German tokens in `01a15a9e-e22f-711d-ad93-cc88d0d2862a`). |

### 2.8 Text Layer Health

| Health Status | Readings | Share | Criteria and Causes |
| --- | ---: | ---: | --- |
| Healthy (`real_word_ratio >= 0.85`, `< 1%` broken characters) | 101 | 93.5% | Clean born-digital text (`65`) or clean OCR layers (`36`). |
| Unhealthy (`real_word_ratio < 0.85` or missing word spaces in OCR) | 7 | 6.5% | All `7` are `scan_ocr` readings (`01a116c7-1c17-75fc-af7d-ccaa2c1d4ea8` at `0.527`, `01a116c7-1c17-75fc-af7d-630cc9d96824` at `0.566`, `01a116c7-1c16-771f-9ef3-f22d83e8e4c5` at `0.597`, `01a15a54-cf0e-76bd-8353-f9b8a49d4d48` at `0.791`, `01a116c7-1c15-713e-8541-12891f6d654c` at `0.819`, `01a116c7-1c17-75fc-af7d-35f4467283b1` at `0.824`, `01a15667-22fb-7289-aa8f-d9769cec97a8` at `0.842`). Caused by older pre-existing OCR layers with missing inter-word spaces or degraded scans. |

---

## 3. References (Chicago 18th Edition, Notes and Bibliography)

Under the **Chicago Manual of Style (18th edition, 2024)**, notes and bibliography entries require:

- **All works**: full given names of all authors (not initials, unless the source itself prints only initials), work kind (`journal article`, `book chapter`, `book`, `primary source`), and full title/subtitle.
- **Book chapter**: chapter title, book title (`container_title`), volume editors' full names (`edited by ...`), publisher, year, chapter page range, and DOI (if assigned). *(Note: Chicago 18th edition dropped the city of publication for books published after 1900, requiring only `Publisher, Year`.)*
- **Journal article**: article title, journal title, volume, issue (`no.`), year, page range, and DOI or stable URL.
- **Book**: book title, author(s) or editor(s), publisher, year, and DOI/ISBN.
- **Primary source**: author/speaker/sender (if applicable), title or document description, full date (day, month, year), and archival collection, repository, or published compilation (such as *Foreign Relations of the United States* or the *Wilson Center Digital Archive*).

### 3.1 Current Finder (`identify.py`) Results by Document Type

Running `identify_audit.py` across all `108` PDFs produces:

| Verdict | Book chapter (`48`) | Journal article (`28`) | Primary source (`26`) | Book (`6`) | Total (`108`) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `same as now` | 3 | 10 | 0 | 1 | 14 |
| `differs on detail` | 1 | 7 | 0 | 0 | 8 |
| `differs on the title` | 21 | 8 | 16 | 3 | 48 |
| `mixed: adds some, lacks or differs on others` | 3 | 1 | 0 | 0 | 4 |
| `worse: has less than now` | 6 | 1 | 1 | 0 | 8 |
| `a different work` | 11 | 1 | 1 | 0 | 13 |
| `nothing found` | 3 | 0 | 8 | 2 | 13 |

| Route (`via`) | Book chapter (`48`) | Journal article (`28`) | Primary source (`26`) | Book (`6`) | Total (`108`) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `crossref` (by DOI) | 13 | 14 | 0 | 2 | 29 |
| `crossref-title` (by layout title query) | 17 | 4 | 0 | 2 | 23 |
| `jstor` (by JSTOR cover regex) | 0 | 10 | 0 | 0 | 10 |
| `layout` (largest font on page 1) | 14 | 0 | 17 | 0 | 31 |
| `metadata` (PDF info dictionary) | 1 | 0 | 1 | 0 | 2 |
| `nothing found` | 3 | 0 | 8 | 2 | 13 |

**Why the current finder fails:**

1. ** strips full given names**: `initials()` in `backend/study/processor/identify.py` turns `"Odd Arne"` into `"O. A."`, whereas Chicago 18th edition requires full given names.
2. **Searches Crossref for `"Chapter 1"` (`11` wrong works on book chapters)**: On `7` book chapters, the heading `"CHAPTER 1"` or `"Chapter 3"` (`9` characters, passing `len(title) >= 8` in `identify.py`) is the largest text on page 1. `from_layout()` extracts `"Chapter 1"` as the title and `search_crossref("Chapter 1")` matches an unrelated medical or engineering paper titled `"Chapter 1"`.
3. **Matches book reviews instead of books/chapters**: When `from_layout()` extracts a book title from a CLA sheet or title page, `search_crossref()` does not filter out `type == "book-review"` or `type == "journal-article"`, returning a 2-page journal review of the book (`2` chapters and `1` article).
4. **Ignores JSTOR Book chapter cover sheets, CLA cover sheets, and ProQuest stamps**: `from_jstor()` only matches `Author(s): ... Source: ...` (journal articles), missing all `5` JSTOR Book chapters (`Book Title:` / `Chapter Title:`), all `5` CLA sheets (`Book title:` / `Extract title:` / `ISBN:`), and all `20` ProQuest Ebook Central stamps.
5. **Drops container fields in `from_work()`**: Even when Crossref returns a `book-chapter` record via DOI, `from_work()` discards `editor`, `publisher`, `volume`, `issue`, `DOI`, and `type`.

### 3.2 How Often Each Chicago Field Can Be Found by Source

#### A. Book Chapters (`n = 48`)

*(43 of the 48 chapters are in edited volumes; 5 are chapters in single-author books.)*

| Chicago Field | 1. DOI / ISBN / JSTOR ID on first pages (`20/48` have an ID) | 2. Publisher / CLA / JSTOR / ProQuest cover page (`41/48` have a cover/stamp) | 3. Running heads & printed page numbers | 4. Crossref (DOI + ISBN + cleaned query, excluding book reviews) | Combined (1-4 + filename fallback) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `author` (surname) | - | 22 / 48 (45.8%) | 20 / 48 (41.7%) | 35 / 48 (72.9%) | 46 / 48 (95.8%) |
| `author_full_given` | - | 22 / 48 (45.8%) | 4 / 48 (8.3%) | 28 / 48 (58.3%) | 41 / 48 (85.4%) |
| `title` (chapter title) | - | 20 / 48 (41.7%) | 26 / 48 (54.2%) | 27 / 48 (56.2%) | 46 / 48 (95.8%) |
| `book_title` (container) | - | 24 / 48 (50.0%) | 27 / 48 (56.2%) | 36 / 48 (75.0%) | 44 / 48 (91.7%) |
| `editors` (`n = 43` edited) | - | 9 / 43 (20.9%) | 3 / 43 (7.0%) | 14 / 43 (32.6%) | 22 / 43 (51.2%) |
| `publisher` | - | 37 / 48 (77.1%) | 0 / 48 (0.0%) | 36 / 48 (75.0%) | 43 / 48 (89.6%) |
| `year` | - | 35 / 48 (72.9%) | 0 / 48 (0.0%) | 36 / 48 (75.0%) | 45 / 48 (93.8%) |
| `pages` (chapter range) | - | 13 / 48 (27.1%) | 44 / 48 (91.7%) | 25 / 48 (52.1%) | 46 / 48 (95.8%) |
| `doi` or `isbn` | 20 / 48 (41.7%) | 20 / 48 (41.7%) | 0 / 48 (0.0%) | 30 / 48 (62.5%) | 32 / 48 (66.7%) |

#### B. Journal Articles (`n = 28`)

| Chicago Field | 1. DOI / JSTOR ID on first pages (`23/28` have an ID) | 2. Publisher / JSTOR / T&F cover page (`24/28` have a cover/stamp) | 3. Running heads & printed page numbers | 4. Crossref (DOI + bibliographic query) | Combined (1-4) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `author` (surname) | - | 24 / 28 (85.7%) | 21 / 28 (75.0%) | 26 / 28 (92.9%) | 28 / 28 (100.0%) |
| `author_full_given` | - | 23 / 28 (82.1%) | 4 / 28 (14.3%) | 22 / 28 (78.6%) | 26 / 28 (92.9%) |
| `title` (article title) | - | 24 / 28 (85.7%) | 19 / 28 (67.9%) | 26 / 28 (92.9%) | 28 / 28 (100.0%) |
| `journal` (container) | - | 24 / 28 (85.7%) | 22 / 28 (78.6%) | 26 / 28 (92.9%) | 28 / 28 (100.0%) |
| `volume` | - | 22 / 28 (78.6%) | 14 / 28 (50.0%) | 26 / 28 (92.9%) | 27 / 28 (96.4%) |
| `issue` | - | 20 / 28 (71.4%) | 11 / 28 (39.3%) | 24 / 28 (85.7%) | 25 / 28 (89.3%) |
| `year` | - | 24 / 28 (85.7%) | 16 / 28 (57.1%) | 26 / 28 (92.9%) | 28 / 28 (100.0%) |
| `pages` | - | 22 / 28 (78.6%) | 25 / 28 (89.3%) | 26 / 28 (92.9%) | 27 / 28 (96.4%) |
| `doi` or `jstor_url` | 23 / 28 (82.1%) | 23 / 28 (82.1%) | 0 / 28 (0.0%) | 26 / 28 (92.9%) | 26 / 28 (92.9%) |

#### C. Books (`n = 6`)

| Chicago Field | 1. DOI / ISBN on first pages | 2. Cover / title / copyright page | 3. Running heads & printed pages | 4. Crossref | Combined (1-4) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `author` + `full_given` | - | 5 / 6 (83.3%) | 2 / 6 (33.3%) | 3 / 6 (50.0%) | 5 / 6 (83.3%) |
| `title` | - | 5 / 6 (83.3%) | 4 / 6 (66.7%) | 3 / 6 (50.0%) | 6 / 6 (100.0%) |
| `publisher` | - | 5 / 6 (83.3%) | 0 / 6 (0.0%) | 3 / 6 (50.0%) | 5 / 6 (83.3%) |
| `year` | - | 5 / 6 (83.3%) | 0 / 6 (0.0%) | 3 / 6 (50.0%) | 5 / 6 (83.3%) |
| `doi` or `isbn` | 3 / 6 (50.0%) | 3 / 6 (50.0%) | 0 / 6 (0.0%) | 3 / 6 (50.0%) | 3 / 6 (50.0%) |

#### D. Primary Sources (`n = 26`)

| Chicago Field | 1. DOI / ISBN / JSTOR | 2. Archive header / cover (`17/26` Wilson Center, FRUS, etc.) | 3. Heading & printed pages | 4. Crossref | Combined (1-3) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `author` / speaker / sender | 0 / 26 | 12 / 26 (46.2%) | 9 / 26 (34.6%) | 0 / 26 | 18 / 26 (69.2%) |
| `title_or_description` | 0 / 26 | 17 / 26 (65.4%) | 24 / 26 (92.3%) | 0 / 26 | 25 / 26 (96.2%) |
| `date` (day/month/year or year) | 0 / 26 | 17 / 26 (65.4%) | 21 / 26 (80.8%) | 0 / 26 | 24 / 26 (92.3%) |
| `archive_or_collection` | 0 / 26 | 18 / 26 (69.2%) | 4 / 26 (15.4%) | 0 / 26 | 19 / 26 (73.1%) |

#### E. OpenAlex Sample of 20 (Where Crossref Had Nothing)

We queried OpenAlex (`https://api.openalex.org/works?search=...`, free, no key) on a sample of `20` readings where Crossref had no match (`9` book chapters, `2` journal articles, `9` primary sources):

- **Matched `7 / 20` (`35.0%`)**, all `7` in the `book chapter` category (`0 / 9` primary sources matched, `0 / 2` journal articles matched).
- **Caveat**: OpenAlex indexes far fewer book chapters and edited-volume metadata fields than Crossref (`0 / 7` returned volume `editors` or `publisher`), and on `2` of the `7` hits OpenAlex returned a journal `book-review` of the book rather than the chapter itself. OpenAlex is therefore only mildly useful as a fallback for book titles/years when filtered to `type in ("book", "book-chapter")`, whereas **Google Books API / OpenLibrary ISBN lookup** or parsing the **CLA / JSTOR Books / Oxford / ProQuest cover page** directly yields much higher accuracy on chapters.

### 3.3 Which Fields Usually Stay Missing Without User Input or Book-Level Lookup

1. **Volume editors (`edited by ...`) on scanned book chapters (`21 / 43` missing from PDF + Crossref)**: Neither CLA digitisation sheets nor ProQuest copyright footers list the book's editors, and Crossref's `book-chapter` records omit `editor` on roughly half of older history volumes. Querying OpenLibrary / Google Books by the book's ISBN or `book_title` recovers most of these, otherwise the user must confirm or enter the editor(s).
2. **Book title (`container_title`) and `publisher` on plain chapter scans (`4-5 / 48` missing)**: When a chapter is scanned directly from a physical book without a CLA sheet, ProQuest stamp, or book-title running head (e.g. when both recto and verso running heads repeat the chapter title or author surname), the book title and publisher only exist in the user's filename or module reading list.
3. **Archival repository / box / folder details on plain scanned primary sources (`7 / 26` missing)**: While Wilson Center CWIHP and FRUS PDFs include structured `Source:` and collection headers, plain scans of historical pamphlets or treaties lack an archive wrapper.
4. **Full given names on older Crossref journal records (`2 / 28` articles)**: Crossref stores only initials (e.g. `"G. H."` or `"H."`) for a few mid-20th-century journal articles when the printed journal header itself used initials.

---

## 4. Text Reflow Quality (`app/src/lib/reflow.ts`)

We ran `app/src/lib/reflow.ts` in Node (`backend/tools/run_reflow.ts`) across all `108` PDFs and saved every output in `backend/audit/reflow/<sha256>.json`. We then scored five fault families automatically against a combined English, French, and German dictionary (`pyspellchecker` + `wordfreq` + `/usr/share/hunspell/en_US.dic`):

1. **`mid_sentence_paras`**: `"para"` blocks that end without terminal punctuation (`.`, `?`, `!`, `:`, `;`, closing quote/bracket) before the next block.
2. **Word faults (`joined_words`, `split_words`, `misread_words`)**:
   - `joined_words`: out-of-vocabulary tokens of length `>= 8` that split cleanly into two valid dictionary words (`word1 + word2`, each `>= 3` letters).
   - `split_words`: adjacent single/short fragment tokens caused by spurious intra-word spaces.
   - `misread_words`: other lowercase out-of-vocabulary tokens (OCR character substitutions, broken glyphs, or truncated stems).
3. **`leftover_hyphens`**: intra-paragraph words still containing `word-\nword` or soft-hyphen line-break artefacts.
4. **`furniture_in_body`**: running heads, standalone page numbers, rotated watermarks, JSTOR/CLA/T&F cover-sheet lines, or ProQuest/Cambridge/Oxford copyright stamps inside `"para"` or `"heading"` blocks.
5. **`footnotes_in_body`**: `"para"` blocks that begin with a footnote marker (`1 Author, Title...`, `12 Ibid.`, `34 See...`) and belong in `"footnote"` blocks.

### 4.1 Fault Counts and Rates by Document Type

| Document Type | Readings | Total Words | `mid_sentence_paras` | `joined_words` | `split_words` | `misread_words` | `leftover_hyphens` | `furniture_in_body` | `footnotes_in_body` | Total Faults (per 1k words) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Book chapter | 48 | 668,934 | 698 (1.04) | 2,522 (3.77) | 767 (1.15) | 7,086 (10.59) | 57 (0.09) | 427 (0.64) | 1,176 (1.76) | 12,733 (19.03 / 1k) |
| Journal article | 28 | 444,806 | 630 (1.42) | 1,037 (2.33) | 56 (0.13) | 4,728 (10.63) | 14 (0.03) | 416 (0.94) | 1,147 (2.58) | 8,028 (18.05 / 1k) |
| Primary source | 26 | 54,866 | 205 (3.74) | 1,128 (20.56) | 3 (0.05) | 717 (13.07) | 24 (0.44) | 105 (1.91) | 36 (0.66) | 2,218 (40.43 / 1k) |
| Book | 6 | 346,778 | 645 (1.86) | 988 (2.85) | 41 (0.12) | 5,970 (17.22) | 7 (0.02) | 147 (0.42) | 306 (0.88) | 8,104 (23.37 / 1k) |
| **All readings** | **108** | **1,515,384** | **2,178 (1.44)** | **5,675 (3.74)** | **867 (0.57)** | **18,501 (12.21)** | **102 (0.07)** | **1,095 (0.72)** | **2,665 (1.76)** | **31,083 (20.51 / 1k)** |

### 4.2 Fault Counts and Rates by Origin (`Born-Digital` vs `Scan with OCR`)

| Origin | Readings | Total Words | `mid_sentence_paras` | `joined_words` | `split_words` | `misread_words` | `leftover_hyphens` | `furniture_in_body` | `footnotes_in_body` | Total Faults (per 1k words) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Born-digital | 65 | 744,856 | 754 (1.01) | 1,245 (1.67) | 58 (0.08) | 6,645 (8.92) | 50 (0.07) | 532 (0.71) | 685 (0.92) | 9,969 (13.38 / 1k) |
| Scan with OCR | 43 | 770,528 | 1,424 (1.85) | 4,430 (5.75) | 809 (1.05) | 11,856 (15.39) | 52 (0.07) | 563 (0.73) | 1,980 (2.57) | 21,114 (27.40 / 1k) |

### 4.3 Ten Worst Readings by Fault Rate (ID Only)

| Rank | Reading ID | Work Kind | Origin | Words | Fault Rate (per 1k) | `mid` | `join` | `split` | `misread` | `hyph` | `furn` | `fn` |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | `01a116c7-1c16-771f-9ef3-f22d83e8e4c5` | Book chapter | `scan_ocr` | 11,977 | **238.4** | 114 | 1,267 | 0 | 1,456 | 0 | 8 | 10 |
| 2 | `01a116c7-1c17-75fc-af7d-630cc9d96824` | Primary source | `scan_ocr` | 2,692 | **196.5** | 21 | 273 | 0 | 232 | 1 | 2 | 0 |
| 3 | `01a116c7-1c17-75fc-af7d-ccaa2c1d4ea8` | Primary source | `scan_ocr` | 5,540 | **179.4** | 7 | 690 | 0 | 283 | 13 | 1 | 0 |
| 4 | `01a15667-22fb-7289-aa8f-d9769cec97a8` | Book | `scan_ocr` | 43,137 | **109.9** | 513 | 568 | 5 | 3,641 | 2 | 9 | 2 |
| 5 | `01a15a54-cf0e-76bd-8353-f9b8a49d4d48` | Primary source | `scan_ocr` | 604 | **97.7** | 3 | 21 | 0 | 33 | 1 | 0 | 1 |
| 6 | `01a116c7-1c16-771f-9ef4-096b83392d5a` | Journal article | `born_digital` | 14,008 | **52.0** | 37 | 4 | 0 | 405 | 6 | 180 | 97 |
| 7 | `01a116c7-1c17-75fc-af7d-84144538f3a3` | Primary source | `born_digital` | 816 | **50.2** | 16 | 0 | 0 | 7 | 0 | 16 | 2 |
| 8 | `01a116c7-1c17-75fc-af7d-1d3ad47fe1f9` | Journal article | `born_digital` | 10,245 | **48.4** | 7 | 46 | 0 | 442 | 1 | 0 | 0 |
| 9 | `01a116c7-1c17-75fc-af7d-9df98984c0af` | Primary source | `scan_ocr` | 1,636 | **46.5** | 8 | 48 | 0 | 17 | 1 | 0 | 2 |
| 10 | `01a116c7-1c17-75fc-af7d-3d3653187487` | Primary source | `born_digital` | 380 | **44.7** | 12 | 3 | 0 | 1 | 0 | 1 | 0 |

### 4.4 Root Causes of `reflow.ts` Faults

1. **Joined words (`5,675` instances)**: In `app/src/lib/reflow.ts` (line 284), `joinWords` only inserts a space between two `pdf.js` text items when `gap > Math.min(prev.h, part.h) * 0.12`. On OCR layers (such as `#1` `01a116c7-1c16-771f-9ef3-f22d83e8e4c5` and `#9` `01a116c7-1c17-75fc-af7d-9df98984c0af`) and tightly set justified lines, `pdf.js` overestimates the bounding-box width `item.width` of the invisible OCR font, making `gap = part.x - (prev.x + prev.w)` slightly negative or `< 0.12 * h` even when a space character or visual gap exists. Separately, on `#2` (`01a116c7-1c17-75fc-af7d-630cc9d96824`) and `#3` (`01a116c7-1c17-75fc-af7d-ccaa2c1d4ea8`), the pre-existing OCR layer inside the PDF has no spaces between words at all, so those files need a fresh OCR pass.
2. **Footnotes mixed into the body (`2,665` instances)**: `reflow.ts` (line 337) classifies a line as a footnote solely by font size (`line.size < body * 0.86`, or `< body * 0.78` on OCR pages). Many books and journals typeset footnotes at `9 pt` under a `10 pt` body (`0.90 >= 0.86`), and OCR layers have noisy glyph heights (`0.80-0.95 * body`). Because those footnotes are labelled as `"para"`, `mergePageTurns()` then stitches the last footnote of page $N$ onto an unfinished body sentence at the bottom of page $N$, trapping the entire footnote block inside the middle of a body paragraph.
3. **Cover sheets, watermarks, and long copyright footers in the body (`1,095` instances)**:
   - `isJstorCover()` only strips JSTOR journal article cover pages (`Author(s):` + `Source:`), leaving JSTOR Books cover sheets, Taylor & Francis cover sheets (`To cite this article:`), and LSE/CLA digitisation sheets in the body.
   - `stripFurniture()` only checks the top/bottom `12%` of the page for lines with `< 70` characters (or `< 110` for repeated text). Multi-line ProQuest Ebook Central footers (`Created from lse on ... Copyright ... All rights reserved. May not be reproduced...`), Cambridge Core footers, and Oxford download stamps are `85-160` characters long and sit up to `15%` from the bottom edge, so they survive on every page and break sentences across page turns.
   - `reflow.ts` ignores the rotation components of `item.transform`, so vertical margin watermarks (`17` readings) are interleaved line-by-line into the body text.
4. **Mid-sentence paragraph breaks (`2,178` instances)**: Caused by (a) unstripped footer stamps and misclassified footnotes interrupting sentences at page turns, (b) `indent > line.size * 0.9` triggering false paragraph breaks on jittered OCR left margins (`#4` `01a15667-22fb-7289-aa8f-d9769cec97a8` has `513` mid-sentence breaks), and (c) 2-page landscape spreads (`2` readings) not being split down the centre gutter before sorting lines by `y`.

---

## 5. Layout Tools Comparison on the Ten Worst Readings

### 5.1 Docling (`docling`) - Skipped (> 2 GB / GPU-oriented)

Running `pip install --dry-run "docling-slim[standard]"` in the WSL environment requires downloading **`> 2.8 GB` of wheel packages** (`> 4 GB` unpacked on disk), including `torch-2.11.0` (`554.6 MB`), `nvidia-cudnn-cu13` (`536.8 MB`), `nvidia-nccl-cu13` (`305.1 MB`), `nvidia-cusparselt-cu13` (`169.8 MB`), CUDA 13 runtime libraries (`~1.2 GB`), and HuggingFace vision model weights (`docling-ibm-models`). Per instructions, we skipped installing Docling.

### 5.2 PyMuPDF Layout (`pymupdf-layout` 1.28.2) vs Today's `reflow.ts`

`pymupdf-layout` is a `42.9 MB` CPU ONNX extension for PyMuPDF (`pymupdf.layout`). Because highlights in Study Library are stored as page-space rectangles on each word, we paired `pymupdf-layout`'s structural layout boxes (`page.get_layout()`) with `page.get_text("words")`, assigning each word (with its exact `(x0, y0, x1, y1)` rectangle) to its enclosing layout block.

- **Word bounding box preservation**: **`0` unboxed words out of `99,328` words** across all `10` readings (`100%` of word rectangles preserved in place).
- **Speed on this laptop (WSL, CPU)**: **`614.8 ms/page`** weighted average across the `263` pages of the `10` worst readings (`434.6 ms/page` to `1,001.6 ms/page` per reading).

| Rank | Reading ID | Pages | `ms/page` | Today (`reflow.ts`) Faults / 1k | `pymupdf-layout` Faults / 1k | Key Change (`today -> pymupdf-layout`) |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | `01a116c7-1c16-771f-9ef3-f22d83e8e4c5` | 36 | 873 ms | 238.4 | **10.4** | `join: 1267 -> 14`, `mid: 114 -> 2`, `misread: 1456 -> 82`, but `fn_in_body: 10 -> 67` |
| 2 | `01a116c7-1c17-75fc-af7d-630cc9d96824` | 9 | 1,002 ms | 196.5 | **188.1** | `mid: 21 -> 3`; `join: 273 -> 268` (underlying PDF OCR layer lacks spaces) |
| 3 | `01a116c7-1c17-75fc-af7d-ccaa2c1d4ea8` | 15 | 882 ms | 179.4 | **174.3** | `hyph: 13 -> 0`; `join: 690 -> 688` (underlying PDF OCR layer lacks spaces) |
| 4 | `01a15667-22fb-7289-aa8f-d9769cec97a8` | 127 | 535 ms | 109.9 | **90.5** | `mid: 513 -> 13`, `join: 568 -> 491`, but `furn_in_body: 9 -> 49` on 2-up spread |
| 5 | `01a15a54-cf0e-76bd-8353-f9b8a49d4d48` | 2 | 964 ms | 97.7 | **23.4** | **Breaks**: mislabelled 3 scanned text blocks as `"picture"`, dropping `604 -> 299` words |
| 6 | `01a116c7-1c16-771f-9ef4-096b83392d5a` | 35 | 513 ms | 52.0 | **32.6** | `furn: 180 -> 1`, `fn_in_body: 97 -> 10`, `mid: 37 -> 2` (2-col article with margin stamp) |
| 7 | `01a116c7-1c17-75fc-af7d-84144538f3a3` | 5 | 550 ms | 50.2 | **14.8** | `mid: 16 -> 0`, `furn: 16 -> 5`, `fn_in_body: 2 -> 0` |
| 8 | `01a116c7-1c17-75fc-af7d-1d3ad47fe1f9` | 20 | 531 ms | 48.4 | **48.4** | `join: 46 -> 21`, `mid: 7 -> 4`; recognised `69` `"footnote"` blocks cleanly |
| 9 | `01a116c7-1c17-75fc-af7d-9df98984c0af` | 11 | 501 ms | 46.5 | **2.6** | `join: 48 -> 0`, `mid: 8 -> 2`, `misread: 17 -> 2`, `fn_in_body: 2 -> 0` |
| 10 | `01a116c7-1c17-75fc-af7d-3d3653187487` | 3 | 435 ms | 44.7 | **10.4** | `mid: 12 -> 2`, `join: 3 -> 1`, `furn: 1 -> 0` |

**Summary of what `pymupdf-layout` fixes vs breaks:**

- **What it fixes**:
  1. Eliminates false mid-sentence paragraph breaks on jittered scans (`738 -> 36` across the 10 readings, `-95.1%`).
  2. Paired with `page.get_text("words")`, eliminates the `pdf.js` overestimated-width word-joining bug (`#1` drops from `1,267` joined words to `14`; `#9` drops from `48` to `0`).
  3. Strips running heads and vertical margin watermarks cleanly on single-page layouts (`#6` furniture drops from `180` to `1`).
- **What it breaks or misses**:
  1. **Drops text inside `"picture"` boxes on scans**: On `#5` (`01a15a54-cf0e-76bd-8353-f9b8a49d4d48`), `pymupdf-layout` classified 3 scanned text regions as `"picture"`, silently discarding half the words on the page (`604 -> 299`).
  2. **Misses footnotes on scans**: It only emitted `"footnote"` labels on `2` of the `10` readings (both born-digital). On `#1` (`scan_ocr`), it labelled bottom-of-page footnotes as `"text"`, increasing `footnotes_in_body` from `10` to `67`. On `#6`, it labelled `93` numbered footnotes as `"list-item"`.
  3. **Cannot fix missing spaces inside a broken OCR layer (`#2`, `#3`)**: Those PDFs require re-running OCR (`OCRmyPDF --force-ocr` or `--redo-ocr`) in the processor when `real_word_ratio < 0.85`.
  4. **Runs in Python (`~615 ms/page`), not in the browser**: Whereas `app/src/lib/reflow.ts` runs directly in the browser on `pdf.js` with zero server storage, `pymupdf-layout` would have to run in the WSL processor and upload a layout JSON per file. Meanwhile, almost every fault `pymupdf-layout` fixed can be fixed directly and deterministically in `app/src/lib/reflow.ts` (plus re-OCRing the `7` unhealthy scans in the processor).

---

## 6. Proposed Golden Set (`backend/audit/golden`)

We generated the hand-checkable golden set in `backend/audit/golden/` (ignored by Git):

### 6.1 Golden Pages (`backend/audit/golden/pages/` and `pages.json`, `25` pages)

Each markdown file contains the expected clean text (`Headings`, `Body Paragraphs`, `Footnotes`) alongside today's `reflow.ts` output for that page:

| # | Reading ID | PDF Page | Category |
| ---: | --- | ---: | --- |
| 1 | `01a116c7-1c16-771f-9ef4-1533a1e858f4` | 2 | Journal article (born-digital, Taylor & Francis opening page) |
| 2 | `01a116c7-1c16-771f-9ef4-1533a1e858f4` | 4 | Journal article (born-digital, Taylor & Francis body page) |
| 3 | `01a116c7-1c15-713e-8541-36fc250f8ac5` | 1 | Journal article (born-digital, Cambridge Core opening page) |
| 4 | `01a116c7-1c15-713e-8541-36fc250f8ac5` | 3 | Journal article (born-digital, Cambridge Core body page) |
| 5 | `01a116c7-1c11-7659-8896-dce630ad475a` | 2 | Book chapter (with rotated vertical margin watermark) |
| 6 | `01a1170a-862f-7120-84ce-775d9b3a13c1` | 3 | Journal article (two-column layout) |
| 7 | `01a116c7-1c14-755e-a91c-c628b3bc9527` | 2 | Journal article (scan with OCR, JSTOR opening body page) |
| 8 | `01a116c7-1c14-755e-a91c-c628b3bc9527` | 4 | Journal article (scan with OCR, JSTOR body and footnotes) |
| 9 | `01a11709-f213-7604-a881-18f5983e8a90` | 2 | Journal article (scan with OCR, JSTOR opening body page) |
| 10 | `01a116c7-1c12-76dc-9dd0-0839a6c3dddb` | 1 | Book chapter (born-digital, Cambridge Core chapter opening) |
| 11 | `01a116c7-1c12-76dc-9dd0-0839a6c3dddb` | 3 | Book chapter (born-digital, Cambridge Core body with footnotes) |
| 12 | `01a116c7-1c0e-70ee-b7a1-5f5bdce202aa` | 2 | Book chapter (born-digital, ProQuest Ebook Central with copyright stamp) |
| 13 | `01a116c7-1c0e-70ee-b7a1-5f5bdce202aa` | 4 | Book chapter (born-digital, ProQuest Ebook Central body page) |
| 14 | `01a116c7-1c0f-75b5-beef-58a79d52f049` | 3 | Book chapter (scan with OCR, LSE/CLA digitised extract) |
| 15 | `01a116c7-1c16-771f-9ef3-f22d83e8e4c5` | 3 | Book chapter (scan with OCR, tight word spacing) |
| 16 | `01a15b3f-70cb-730e-9eb2-117d5228e2e6` | 16 | Book (born-digital, multilingual passages) |
| 17 | `01a15667-22fb-7289-aa8f-d9769cec97a8` | 13 | Book (scan with OCR, Tesseract/OCRmyPDF layer) |
| 18 | `01a116c7-1c17-75fc-af7d-3d3653187487` | 1 | Primary source (born-digital, Wilson Center Digital Archive memorandum) |
| 19 | `01a116c7-1c17-75fc-af7d-6fa6cfcc08c4` | 1 | Primary source (born-digital, FRUS diplomatic document) |
| 20 | `01a116c7-1c17-75fc-af7d-630cc9d96824` | 1 | Primary source (scan with OCR, archival document) |
| 21 | `01a116c7-1c17-75fc-af7d-35f4467283b1` | 2 | Primary source (born-digital, continuation page) |
| 22 | `01a116c7-1c0f-75b5-beef-58a79d52f049` | 2 | Book chapter (`scan_ocr`) |
| 23 | `01a116c7-1c0f-75b5-beef-6671b2cb7343` | 2 | Book chapter (`born_digital`) |
| 24 | `01a116c7-1c0f-75b5-beef-70bc0a0be72f` | 2 | Book (`scan_ocr`, two-page landscape spread) |
| 25 | `01a116c7-1c10-7335-b6f4-ee01e86e91b3` | 2 | Journal article (`born_digital`) |

### 6.2 Golden Chicago 18th Edition References (`backend/audit/golden/references.md` and `references.json`, `10` readings)

| # | Reading ID | Category |
| ---: | --- | --- |
| 1 | `01a1170a-862f-7120-84ce-775d9b3a13c1` | Journal article (JSTOR scan) |
| 2 | `01a116c7-1c16-771f-9ef4-1533a1e858f4` | Journal article (Taylor & Francis born-digital) |
| 3 | `01a116c7-1c11-7659-8896-f7b0685ae85a` | Journal article (Cambridge/Oxford born-digital) |
| 4 | `01a116c7-1c12-76dc-9dd0-0839a6c3dddb` | Book chapter (Cambridge edited volume, born-digital) |
| 5 | `01a1170a-862b-714b-82b0-fcb2524b1d4b` | Book chapter (Oxford Scholarship Online, born-digital) |
| 6 | `01a116c7-1c0f-75b5-beef-58a79d52f049` | Book chapter (LSE/CLA digitised extract, scan with OCR) |
| 7 | `01a116c7-1c0f-75b5-beef-70bc0a0be72f` | Book (monograph) |
| 8 | `01a116c7-1c15-713e-8541-2845f44e1732` | Book (monograph) |
| 9 | `01a116c7-1c17-75fc-af7d-3d3653187487` | Primary source (Wilson Center Digital Archive) |
| 10 | `01a116c7-1c17-75fc-af7d-6fa6cfcc08c4` | Primary source (Foreign Relations of the United States) |

---

## 7. Decisions Needed Before Implementation

1. **Where to store the extra Chicago reference fields (`work_kind`, full `authors`, `editors`, `container_title`, `publisher`, `volume`, `issue`, `doi`, `url`, `date`, `archive`)**:
   - **Option A (Recommended)**: Keep the existing 5 columns (`author`, `year`, `title`, `source`, `pages`) for cards, lists, and sorting (storing full given names in `author`), and add a single JSON column `reference_json` (or `citation`) on `items` to hold the full structured Chicago fields without schema churn.
   - **Option B**: Add individual SQLite/D1 columns for every Chicago field.
2. **Where text reflow should run**:
   - **Option A (Recommended)**: Keep reflow in `app/src/lib/reflow.ts` on the device (so it works offline with zero extra storage), fixing its five root causes directly (rotated watermark filtering, cover-sheet detectors for CLA / T&F / JSTOR Books, provider stamp stripping for ProQuest / Cambridge / Oxford, position + marker footnote detection, 2-up landscape page splitting, and character-aware word spacing). Pair this with re-OCRing the `7` unhealthy pre-existing scans in the processor when `real_word_ratio < 0.85`.
   - **Option B**: Run `pymupdf-layout` + heuristic post-processing in the Python processor and sync a precomputed layout JSON for every PDF.
3. **Rescanning the `7` unhealthy OCR layers (`real_word_ratio < 0.85`)**:
   - Should the processor automatically re-run `OCRmyPDF --redo-ocr` on the `7` readings whose existing publisher/archive OCR layer has missing word spaces or `< 85%` real words?
