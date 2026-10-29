"""Search with retrieval: BM25 finds candidates, the local checker picks passages and answers.

See docs/CONTRACTS.md, Workspace. The keyword search (index.search) pulls up to `candidates`
passages; the checker model reads them with every roster name, known value and identifier
already swapped for tags, picks the ones that help (at most `keep`) and writes a short answer
from them. The answer is restored to real names on the device, and the connector releases the
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
