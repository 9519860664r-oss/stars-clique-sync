import os
import tempfile
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from faster_whisper import WhisperModel


MODEL_NAME = os.getenv("STARS_SYNC_WHISPER_MODEL", "medium")
DEVICE = os.getenv("STARS_SYNC_WHISPER_DEVICE", "auto")
COMPUTE_TYPE = os.getenv("STARS_SYNC_WHISPER_COMPUTE", "auto")
LANGUAGE_HINT = os.getenv("STARS_SYNC_WHISPER_LANGUAGE", "").strip() or None
PHRASE_MAX_WORDS = int(os.getenv("STARS_SYNC_PHRASE_MAX_WORDS", "12"))
PHRASE_MAX_SECONDS = float(os.getenv("STARS_SYNC_PHRASE_MAX_SECONDS", "5.0"))
PHRASE_PAUSE_SECONDS = float(os.getenv("STARS_SYNC_PHRASE_PAUSE_SECONDS", "0.55"))
LYRICS_PROMPT = os.getenv("STARS_SYNC_WHISPER_PROMPT", "").strip() or None
SUPPORTED_LANGUAGE_HINTS = {"en", "ru", "uk", "es", "fr", "de", "it", "pt", "pl"}

app = FastAPI(title="Stars Clique Sync AI Backend", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

model: WhisperModel | None = None


def get_model() -> WhisperModel:
    global model
    if model is None:
        model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
    return model


@app.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "model": MODEL_NAME,
        "device": DEVICE,
        "compute_type": COMPUTE_TYPE,
        "language_hint": LANGUAGE_HINT or "auto",
    }


def clean_word(value: str) -> str:
    return value.strip().strip(" \t\r\n")


def normalize_language_hint(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.strip().lower()
    if normalized in {"", "auto"}:
        return None
    if normalized not in SUPPORTED_LANGUAGE_HINTS:
        raise HTTPException(status_code=400, detail=f"Unsupported language hint: {value}")
    return normalized


def normalize_word(value: str) -> str:
    return clean_word(value).lower().strip(".,!?;:\"'()[]{}\u00ab\u00bb")


def text_tokens(value: str) -> list[str]:
    return [token for token in (normalize_word(part) for part in value.split()) if token]


def is_non_lyric_artifact(text: str) -> bool:
    normalized = " ".join(text_tokens(text))
    if not normalized:
        return True

    artifact_phrases = (
        "thanks for watching",
        "thank you for watching",
        "see you in the next",
        "next video",
        "like and subscribe",
        "dont forget to subscribe",
        "don't forget to subscribe",
        "subscribe to my channel",
        "смотрите дальше",
        "спасибо за просмотр",
        "подписывайтесь",
        "ставьте лайк",
        "до встречи в следующем",
    )
    return any(phrase in normalized for phrase in artifact_phrases)


def is_low_confidence_segment(segment: Any) -> bool:
    avg_logprob = getattr(segment, "avg_logprob", None)
    no_speech_prob = getattr(segment, "no_speech_prob", None)
    compression_ratio = getattr(segment, "compression_ratio", None)

    if no_speech_prob is not None and no_speech_prob >= 0.82:
        return True
    if avg_logprob is not None and avg_logprob <= -1.35:
        return True
    if compression_ratio is not None and compression_ratio >= 3.0:
        return True
    return False


def tail_signature(tokens: list[str]) -> tuple[str, ...] | None:
    if len(tokens) < 4:
        return None
    tail_size = min(5, len(tokens))
    return tuple(tokens[-tail_size:])


def starts_new_lyric_clause(word: dict[str, Any], previous_words: list[dict[str, Any]]) -> bool:
    if len(previous_words) < 4:
        return False

    token = normalize_word(str(word["text"]))
    if not token:
        return False

    previous_token = normalize_word(str(previous_words[-1]["text"]))
    continuation_words = {
        "and",
        "or",
        "but",
        "to",
        "for",
        "with",
        "about",
        "without",
        "of",
        "from",
        "in",
        "on",
        "that",
        "cause",
        "because",
        "\u0430",
        "\u0438",
        "\u0438\u043b\u0438",
        "\u043d\u043e",
        "\u0447\u0442\u043e",
        "\u0447\u0442\u043e\u0431",
        "\u0447\u0442\u043e\u0431\u044b",
        "\u043a\u0430\u043a",
        "\u0434\u043b\u044f",
        "\u0431\u0435\u0437",
        "\u043e",
        "\u043e\u0431",
        "\u043e\u0442",
        "\u0438\u0437",
        "\u0441",
        "\u0441\u043e",
        "\u043d\u0430",
        "\u0432",
        "\u0432\u043e",
    }
    if previous_token in continuation_words:
        return False

    clause_starts = {
        "i",
        "im",
        "i'm",
        "you",
        "youre",
        "you're",
        "we",
        "we're",
        "they",
        "he",
        "she",
        "baby",
        "girl",
        "boy",
        "every",
        "even",
        "but",
        "\u044f",
        "\u0442\u044b",
        "\u043c\u044b",
        "\u0432\u044b",
        "\u043e\u043d",
        "\u043e\u043d\u0430",
        "\u043e\u043d\u0438",
        "\u044d\u0442\u043e",
        "\u043c\u043d\u0435",
        "\u043c\u0435\u043d\u044f",
        "\u0442\u0435\u0431\u044f",
        "\u0442\u0435\u0431\u0435",
        "\u043c\u043e\u0439",
        "\u043c\u043e\u044f",
        "\u043c\u043e\u0438",
        "\u043a\u0430\u0436\u0434\u044b\u0439",
        "\u043a\u0430\u0436\u0434\u0430\u044f",
        "\u043a\u043e\u0433\u0434\u0430",
        "\u0435\u0441\u043b\u0438",
    }
    if token in clause_starts:
        return True

    raw = clean_word(str(word["text"]))
    return len(previous_words) >= 6 and raw[:1].isupper()


def is_punctuation_boundary(previous_word: dict[str, Any], phrase: list[dict[str, Any]]) -> bool:
    if not str(previous_word["text"]).strip().endswith((".", "?", "!", ",", ";", ":")):
        return False

    phrase_duration = float(previous_word["end"]) - float(phrase[0]["start"]) if phrase else 0
    # Whisper often inserts commas after short openers like "Baby girl,".
    # Keep those attached to the phrase that follows.
    return len(phrase) >= 4 or phrase_duration >= 1.8


def phrase_from_words(index: int, words: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not words:
        return None

    text = " ".join(word["text"] for word in words).strip()
    if not text:
        return None

    return {
        "id": f"line-{index}",
        "text": text,
        "start": float(words[0]["start"]),
        "end": float(words[-1]["end"]),
        "source": "auto",
        "confidence": 0,
        "words": words,
    }


def is_suspicious_short_tail(line: dict[str, Any], index: int, total: int) -> bool:
    if index != total - 1:
        return False

    tokens = text_tokens(str(line.get("text", "")))
    if len(tokens) != 1:
        return False

    start = line.get("start")
    end = line.get("end")
    duration = float(end) - float(start) if isinstance(start, int | float) and isinstance(end, int | float) else 0
    common_fragments = {
        "i",
        "im",
        "you",
        "youre",
        "я",
        "ты",
        "мы",
        "он",
        "она",
    }
    return duration <= 0.4 or tokens[0] in common_fragments


def split_segment_into_phrases(segment: Any, start_index: int) -> tuple[list[dict[str, Any]], int]:
    words = [
        {
            "text": clean_word(word.word),
            "start": float(word.start),
            "end": float(word.end),
        }
        for word in (segment.words or [])
        if word.word and clean_word(word.word) and word.start is not None and word.end is not None
    ]

    if not words:
        text = segment.text.strip()
        if not text:
            return [], start_index
        return [
            {
                "id": f"line-{start_index}",
                "text": text,
                "start": float(segment.start),
                "end": float(segment.end),
                "source": "auto",
                "confidence": 0,
                "words": [],
            }
        ], start_index + 1

    lines: list[dict[str, Any]] = []
    phrase: list[dict[str, Any]] = []
    next_index = start_index

    for word in words:
        previous = phrase[-1] if phrase else None
        gap = float(word["start"]) - float(previous["end"]) if previous else 0
        phrase_duration = float(word["end"]) - float(phrase[0]["start"]) if phrase else 0
        should_split = (
            bool(phrase)
            and (
                gap >= PHRASE_PAUSE_SECONDS
                or is_punctuation_boundary(previous, phrase)
                or phrase_duration >= PHRASE_MAX_SECONDS
                or len(phrase) >= PHRASE_MAX_WORDS
                or starts_new_lyric_clause(word, phrase)
            )
        )

        if should_split:
            line = phrase_from_words(next_index, phrase)
            if line:
                lines.append(line)
                next_index += 1
            phrase = []

        phrase.append(word)

    line = phrase_from_words(next_index, phrase)
    if line:
        lines.append(line)
        next_index += 1

    return lines, next_index


def line_confidence(line: dict[str, Any]) -> float:
    confidence = line.get("confidence")
    if isinstance(confidence, int | float):
        return float(confidence)
    return 0.0


def remove_suspicious_short_tails(lines: list[dict[str, Any]]) -> int:
    before = len(lines)
    kept = [
        line
        for index, line in enumerate(lines)
        if not is_suspicious_short_tail(line, index, len(lines))
    ]
    if len(kept) == before:
        return 0

    lines[:] = kept
    for index, line in enumerate(lines, start=1):
        line["id"] = f"line-{index}"
    return before - len(lines)


def apply_repeated_phrase_consensus(lines: list[dict[str, Any]]) -> int:
    tokenized_lines = [text_tokens(str(line.get("text", ""))) for line in lines]
    token_counts = Counter(token for tokens in tokenized_lines for token in tokens)
    clusters: dict[tuple[str, ...], list[int]] = defaultdict(list)

    for index, tokens in enumerate(tokenized_lines):
        signature = tail_signature(tokens)
        if signature:
            clusters[signature].append(index)

    changes = 0
    for indexes in clusters.values():
        if len(indexes) < 2:
            continue

        variants: dict[str, dict[str, Any]] = {}
        for index in indexes:
            text = str(lines[index].get("text", "")).strip()
            tokens = tokenized_lines[index]
            if not text or not tokens:
                continue
            key = " ".join(tokens)
            variant = variants.setdefault(
                key,
                {
                    "text": text,
                    "count": 0,
                    "token_score": 0.0,
                    "confidence": 0.0,
                },
            )
            variant["count"] += 1
            variant["token_score"] += sum(token_counts[token] for token in tokens) / max(1, len(tokens))
            variant["confidence"] += line_confidence(lines[index])

        if len(variants) < 2:
            continue

        best = max(
            variants.values(),
            key=lambda variant: (
                int(variant["count"]),
                float(variant["token_score"]) / max(1, int(variant["count"])),
                float(variant["confidence"]) / max(1, int(variant["count"])),
            ),
        )
        canonical_text = str(best["text"]).strip()
        if not canonical_text:
            continue

        for index in indexes:
            current_text = str(lines[index].get("text", "")).strip()
            if current_text and current_text != canonical_text:
                lines[index]["text"] = canonical_text
                lines[index]["source"] = "auto"
                lines[index]["consensus"] = True
                changes += 1

    return changes


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    language: str | None = Form(default=None),
) -> dict[str, Any]:
    contents = await audio.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Upload an audio file.")

    suffix = Path(audio.filename or "audio").suffix or ".audio"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as temp:
        temp_path = Path(temp.name)
        temp.write(contents)

    try:
        selected_language = normalize_language_hint(language) or LANGUAGE_HINT

        def run_pass(vad_filter: bool) -> tuple[list[dict[str, Any]], list[str], Any]:
            segments, info = get_model().transcribe(
                str(temp_path),
                beam_size=8,
                best_of=5,
                patience=1.2,
                vad_filter=vad_filter,
                word_timestamps=True,
                condition_on_previous_text=False,
                language=selected_language,
                initial_prompt=LYRICS_PROMPT,
                temperature=0,
                compression_ratio_threshold=2.4,
                log_prob_threshold=-1.0,
                no_speech_threshold=0.6,
                hallucination_silence_threshold=1.0,
            )
            lines = []
            next_index = 1

            for segment in segments:
                text = segment.text.strip()
                if not text:
                    continue
                if is_non_lyric_artifact(text) or is_low_confidence_segment(segment):
                    continue
                segment_lines, next_index = split_segment_into_phrases(segment, next_index)
                lines.extend(
                    line for line in segment_lines if not is_non_lyric_artifact(str(line.get("text", "")))
                )

            full_text_parts = [line["text"] for line in lines]
            return lines, full_text_parts, info

        lines, full_text_parts, info = run_pass(vad_filter=False)
        pass_name = "no_vad"
        if not full_text_parts:
            lines, full_text_parts, info = run_pass(vad_filter=True)
            pass_name = "vad_fallback"

        removed_short_tails = remove_suspicious_short_tails(lines)
        consensus_changes = apply_repeated_phrase_consensus(lines)
        full_text_parts = [line["text"] for line in lines]

        return {
            "status": "ok" if full_text_parts else "empty",
            "message": "" if full_text_parts else "No lyrics detected. Try clearer audio or a larger Whisper model.",
            "text": "\n".join(full_text_parts),
            "language": info.language,
            "language_probability": info.language_probability,
            "language_hint": selected_language or "auto",
            "model": MODEL_NAME,
            "pass": pass_name,
            "consensus_changes": consensus_changes,
            "removed_short_tails": removed_short_tails,
            "phrase": {
                "max_words": PHRASE_MAX_WORDS,
                "max_seconds": PHRASE_MAX_SECONDS,
                "pause_seconds": PHRASE_PAUSE_SECONDS,
            },
            "lines": lines,
        }
    finally:
        temp_path.unlink(missing_ok=True)
