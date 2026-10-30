"""Search with retrieval: the local checker rewrites the query, the index finds passages, and the
checker picks the ones that answer and writes a short answer.

See docs/CONTRACTS.md, Workspace. `retrieve` asks the checker for up to 3 more search queries
(other words the documents may use), then index.passages ranks ~800-character pieces for all of
them at once (BM25 plus meaning, fused); the checker model reads them with every roster name,
known value and identifier already swapped for tags, picks the ones that help (at most `keep`)
and writes a short answer from them. The answer is restored to real names on the device, and the connector releases the
answer and the picked passages through egress like any search result, so they are tagged,
checked and routed the same way.
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

NO_ANSWER = "No passage answers this."
RAG_MAX_TOKENS = 1200

RAG_PROMPT = (
    "You answer a question from a teacher's own documents, using only the numbered passages you "
    "are given. Pick the passages that help answer the question, at most {keep}, best first. Then "
    "write a short answer, one to three sentences, that uses only what the picked passages say. "
    "People appear as tags such as [Student A] or [Person 1]: copy tags exactly and never guess "
    f'who they are. If no passage helps, pick none and answer "{NO_ANSWER}" '
    'Reply with JSON only: {{"passages": [numbers], "answer": "..."}}.'
)

REWRITE_PROMPT = (
    "You help search a teacher's own documents. Write up to 3 short search queries for the question: "
    "other words, phrasings and related terms the documents might use, not the question repeated. "
    "People appear as tags such as [Student A]: copy tags exactly. "
    'Reply with JSON only: {"queries": ["...", "..."]}.'
)

REWRITE_SCHEMA = {
    "name": "search_queries",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {"queries": {"type": "array", "items": {"type": "string"}}},
        "required": ["queries"],
        "additionalProperties": False,
    },
}
MAX_EXTRA_QUERIES = 3

RAG_SCHEMA = {
    "name": "rag_answer",
    "strict": True,
    "schema": {
        "type": "object",
        "properties": {
            "passages": {"type": "array", "items": {"type": "integer"}},
            "answer": {"type": "string"},
        },
        "required": ["passages", "answer"],
        "additionalProperties": False,
    },
}


class Rag:
    def __init__(self, llm: Any, roster: Any, tagmap: Any, *, candidates: int = 20, keep: int = 5):
        if getattr(llm, "is_cloud", True):
            raise ValueError("retrieval reads raw passages, so only a model on this device may run it")
        self.llm = llm
        self.roster = roster
        self.tagmap = tagmap
        self.candidates = candidates
        self.keep = keep

    def _view(self, text: str) -> str:
        from base import guard  # lazy, like the agent's model view

        return guard.tag(text, self.roster, self.tagmap).text

    def queries(self, question: str) -> list[str]:
        """The question plus up to 3 queries the checker wrote, with tags restored to real values so
        they match the raw documents. Just the question when the model call fails."""
        from base import guard

        out = [question]
        try:
            data = self.llm.chat_json(
                [
                    {"role": "system", "content": REWRITE_PROMPT},
                    {"role": "user", "content": f"Question: {self._view(question)}"},
                ],
                REWRITE_SCHEMA,
                max_tokens=300,
            )
        except Exception as exc:
            log.warning("query rewriting failed, searching the question only: %s", type(exc).__name__)
            return out
        for value in (data.get("queries") or [])[:MAX_EXTRA_QUERIES]:
            q = guard.restore(str(value).strip(), self.tagmap)[:300]
            if q and q.lower() not in {o.lower() for o in out}:
                out.append(q)
        return out

    def retrieve(self, index: Any, question: str, folder: str | None = None, k: int | None = None) -> list[Any]:
        """The best passages for the question and the rewritten queries (index.passages)."""
        return index.passages(self.queries(question), k=k or self.candidates, folder=folder)

    def pick(self, query: str, snippets: list[Any]) -> tuple[list[Any], str]:
        """(the passages the model picked, best first, and its answer with real names restored).

        Raises when the model call fails; the caller falls back to the keyword ranking.
        """
        if not snippets:
            return [], NO_ANSWER
        listed = "\n\n".join(
            f"[{i}] {self._view(_get(s, 'title', ''))}\n{self._view(_get(s, 'text', ''))}"
            for i, s in enumerate(snippets, 1)
        )
        data = self.llm.chat_json(
            [
                {"role": "system", "content": RAG_PROMPT.format(keep=self.keep)},
                {"role": "user", "content": f"Question: {self._view(query)}\n\nPassages:\n\n{listed}"},
            ],
            RAG_SCHEMA,
            max_tokens=RAG_MAX_TOKENS,
        )
        picked: list[int] = []
        for value in data.get("passages") or []:
            try:
                n = int(value)
            except (TypeError, ValueError):
                continue
            if 1 <= n <= len(snippets) and n not in picked:
                picked.append(n)
        picked = picked[: self.keep]
        answer = str(data.get("answer") or "").strip() or NO_ANSWER
        if not picked:
            return [], NO_ANSWER
        from base import guard

        return [snippets[n - 1] for n in picked], guard.restore(answer, self.tagmap)


def _get(obj: Any, name: str, default: Any = None) -> Any:
    return obj.get(name, default) if isinstance(obj, dict) else getattr(obj, name, default)
