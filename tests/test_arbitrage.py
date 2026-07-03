"""Unit tests for the ProphetLabs arbitrage engine (pure functions only)."""
import importlib

import pytest

backend = importlib.import_module("src.core.prophetlabs_backend")

Market = backend.Market
find_arbitrage = backend.find_arbitrage
norm = backend.norm
extract_fields = backend.extract_fields
compatible = backend.compatible


def make_market(exchange, yes, no, **kwargs):
    return Market(
        id=kwargs.get("id", f"{exchange}-1"),
        question=kwargs.get("question", "Will X happen?"),
        slug=kwargs.get("slug", "will-x-happen"),
        exchange=exchange,
        outcomes=["Yes", "No"],
        token_ids={"Yes": "t1", "No": "t2"},
        prices={"Yes": yes, "No": no},
    )


# ── Market price properties ─────────────────────────────────────

class TestMarketPrices:
    def test_yes_no_price_from_labels(self):
        m = make_market("polymarket", 0.62, 0.38)
        assert m.yes_price == 0.62
        assert m.no_price == 0.38

    def test_no_price_derived_when_missing(self):
        m = Market(id="1", question="q", slug="s", exchange="opinion",
                   outcomes=["Yes"], token_ids={}, prices={"Yes": 0.7})
        assert m.no_price == pytest.approx(0.3)


# ── find_arbitrage ──────────────────────────────────────────────

class TestFindArbitrage:
    def test_detects_poly_yes_opinion_no(self):
        # Poly YES 0.40 + Opinion NO 0.50 = 0.90 → 10% profit
        pm = make_market("polymarket", 0.40, 0.60)
        om = make_market("opinion", 0.50, 0.50)
        opps = find_arbitrage([(pm, om, 0.95)])
        assert len(opps) == 1
        assert opps[0]["dir"] == "py_on"
        assert opps[0]["prof"] == pytest.approx(10.0)

    def test_detects_poly_no_opinion_yes(self):
        # Poly NO 0.45 + Opinion YES 0.45 = 0.90 → 10% profit
        pm = make_market("polymarket", 0.55, 0.45)
        om = make_market("opinion", 0.45, 0.55)
        opps = find_arbitrage([(pm, om, 0.95)])
        assert len(opps) == 1
        assert opps[0]["dir"] == "pn_oy"
        assert opps[0]["prof"] == pytest.approx(10.0)

    def test_no_opportunity_when_prices_efficient(self):
        pm = make_market("polymarket", 0.50, 0.50)
        om = make_market("opinion", 0.52, 0.50)
        assert find_arbitrage([(pm, om, 0.95)]) == []

    def test_skips_degenerate_prices(self):
        pm = make_market("polymarket", 0.40, 0.60)
        om = make_market("opinion", 1.0, 0.0)
        assert find_arbitrage([(pm, om, 0.95)]) == []

    def test_skips_market_without_prices(self):
        pm = make_market("polymarket", 0.40, 0.60)
        om = Market(id="2", question="q", slug="s", exchange="opinion",
                    outcomes=["Yes", "No"], token_ids={}, prices={})
        assert find_arbitrage([(pm, om, 0.95)]) == []

    def test_sorted_by_profit_descending(self):
        pm1 = make_market("polymarket", 0.40, 0.60)   # 10% opp
        om1 = make_market("opinion", 0.50, 0.50)
        pm2 = make_market("polymarket", 0.30, 0.70)   # 20% opp
        om2 = make_market("opinion", 0.50, 0.50)
        opps = find_arbitrage([(pm1, om1, 0.9), (pm2, om2, 0.9)])
        profs = [o["prof"] for o in opps]
        assert profs == sorted(profs, reverse=True)
        assert opps[0]["prof"] == pytest.approx(20.0)

    def test_spread_reported_in_percent(self):
        pm = make_market("polymarket", 0.40, 0.60)
        om = make_market("opinion", 0.50, 0.50)
        opps = find_arbitrage([(pm, om, 0.95)])
        assert opps[0]["spread"] == pytest.approx(10.0)


# ── Matching helpers ────────────────────────────────────────────

class TestMatching:
    def test_norm_lowercases_and_strips(self):
        assert norm("Will BTC Hit $100k?") == norm("will btc hit $100k")

    def test_extract_fields_returns_dict(self):
        f = extract_fields("Will Bitcoin reach $150,000 by December 31?")
        assert isinstance(f, dict)

    def test_same_question_is_compatible(self):
        q = "Will Bitcoin reach $150,000 by December 31, 2026?"
        assert compatible(extract_fields(q), extract_fields(q))

    def test_different_targets_incompatible(self):
        f1 = extract_fields("Will Bitcoin reach $150,000 by December 31, 2026?")
        f2 = extract_fields("Will Bitcoin reach $200,000 by December 31, 2026?")
        assert not compatible(f1, f2)
