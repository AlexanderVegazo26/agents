#!/usr/bin/env python3
"""Unit tests for the OpenMuse-style line diff in condition_monitor.py (pure functions, no network)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import condition_monitor as cm  # noqa: E402


class PageDiffTest(unittest.TestCase):
    def test_relative_time_only_is_quiet(self):
        a = cm.page_lines("Release v1.2\nposted 3 minutes ago\nhace 2 horas")
        b = cm.page_lines("Release v1.2\nposted 1 hour ago\nhace 5 horas")
        d = cm.diff_page(a, b)
        self.assertEqual(cm.count_diff(d), "")
        self.assertEqual(cm.without_relative_times("posted 3 minutes ago"),
                         cm.without_relative_times("posted 1 hour ago"))

    def test_number_change_is_update(self):
        d = cm.diff_page(["Pro plan $20 per month", "Footer"], ["Pro plan $25 per month", "Footer"])
        self.assertEqual(d, {"added": [], "updated": ["Pro plan $25 per month"], "removed": []})

    def test_added_and_removed(self):
        d = cm.diff_page(["a", "b", "c"], ["a", "c", "d new"])
        self.assertEqual(d["added"], ["d new"])
        self.assertEqual(d["removed"], ["b"])
        self.assertIn("New:\n• d new", cm.describe_diff(d))
        self.assertEqual(cm.count_diff(d), "2 lines changed (1 new, 1 removed)")

    def test_page_lines_from_html_blocks(self):
        lines = cm.page_lines(cm._raw_text("<ul><li>One</li><li>Two  words</li></ul><script>x=1</script>"))
        self.assertEqual(lines, ["One", "Two words"])

    def test_any_price_below(self):
        w = {"name": "p", "kind": "price_below", "condition": "10"}
        r = cm.evaluate(w, b"<p>Basic $49</p><p>Hobby USD 9.99</p>", "text/html")
        self.assertEqual(r["state"], "alert")
        self.assertEqual(r["value"], 9.99)


if __name__ == "__main__":
    unittest.main()
