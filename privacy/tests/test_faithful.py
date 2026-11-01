"""eval/faithful.py: numbers and quotes a written summary adds to its result. Invented text only."""

from __future__ import annotations

from eval import faithful as f

RESULT = "Club average is 84 points across 18 members, with scores ranging from 71 to 98. 14 of 18 passed."


def test_numbers_the_result_states_or_one_step_from_it_are_supported():
    c = f.check("The club averaged 84 points (18 members), ranging 71 to 98; 4 did not pass, 78% passed.", RESULT)
    assert c == {"numbers": 6, "unsupported_numbers": 0, "quotes": 0, "unsupported_quotes": 0}


def test_an_invented_number_is_counted():
    c = f.check("The club averaged 87 points, and 3 members scored perfect marks.", RESULT)
    assert c["unsupported_numbers"] == 2  # 87, and the count 3, which the result neither states nor implies
    assert f.unsupported(c)


def test_column_means_of_per_student_scores_are_supported():
    result = "Scores (Ideas/Organization): Ann Example 4/3; Bo Example 3/3; Cy Example 2/1; Di Example 3/2"
    assert f.check("Class averages: Ideas 3.0, Organization 2.25 (2.3), across 4 essays.", result)["unsupported_numbers"] == 0
    assert f.check("Class average for Ideas: 3.4.", result)["unsupported_numbers"] == 1


def test_the_mean_of_a_list_of_totals_after_names_is_supported():
    result = "Totals out of 16: Ann Example 15; Bo Example 12; Cy Example 10; Di Example 7."
    assert f.check("Average total 11 of 16 (11.0), median 11, across 4 essays.", result)["unsupported_numbers"] == 0


def test_a_reference_summary_supports_counts_of_listed_names():
    result = "Answer an opposing view: Ann Example, Bo Example, Cy Example."
    assert f.check("3 of 4 essays answer an opposing view.", result)["unsupported_numbers"] == 2
    assert f.check("3 of 4 essays answer an opposing view.", result, "3 of 4 essays do.")["unsupported_numbers"] == 0
    assert f.check("5 of 4 essays answer it.", result, "3 of 4 essays do.")["unsupported_numbers"] == 1


def test_a_quote_must_be_in_the_result_word_for_word_with_tags_for_names():
    result = 'Ann Example wrote "the garden grows in the dark" and Bo Example wrote "we planted beans".'
    good = f.check('One essay says "the garden grows in the dark", by [Student B].', result)
    assert (good["quotes"], good["unsupported_quotes"]) == (1, 0)
    tagged = f.check('A line reads "[Student A] wrote “the garden"', 'Ann Example wrote "the garden grows"')
    assert tagged["unsupported_quotes"] in (0, 1)  # nested quotes are not parsed; never an error
    bad = f.check('A student wrote "the beans grew tall overnight".', result)
    assert bad["unsupported_quotes"] == 1


def test_tags_carry_no_numbers_and_nothing_is_returned_but_counts():
    c = f.check("[Phone 1] and [Student C] were left out. 18 members.", RESULT)
    assert c["numbers"] == 1 and c["unsupported_numbers"] == 0
    assert all(isinstance(v, int) for v in c.values())


def test_merge_adds_counts_and_none_when_empty():
    assert f.merge([]) is None
    assert f.merge([{"numbers": 1, "unsupported_numbers": 1}, {"numbers": 2, "unsupported_numbers": 0}]) == {
        "numbers": 3, "unsupported_numbers": 1}
