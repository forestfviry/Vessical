"""Unit test for ITEM 1: every LIME entry's `value` must equal the input value
of the feature named in `feature` (not a row, not a neighbouring column)."""
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from backend_fixes import lime_explanation


def _toy():
    rng = np.random.default_rng(0)
    cols = ["Age", "Sex", "DM", "BP", "FBS", "EF_TTE"]
    X = pd.DataFrame({
        "Age": rng.integers(30, 85, 200).astype(float),
        "Sex": rng.integers(0, 2, 200).astype(float),
        "DM": rng.integers(0, 2, 200).astype(float),
        "BP": rng.normal(130, 15, 200),
        "FBS": rng.normal(100, 20, 200),
        "EF_TTE": rng.normal(50, 8, 200),
    })[cols]
    y = (((X["Age"] > 60) & (X["DM"] == 1)) | (X["BP"] > 145)).astype(int)
    return LogisticRegression(max_iter=1000).fit(X, y), X


def _check(entries, x_row):
    assert entries, "no explanation returned"
    for e in entries:
        print(f"{e['feature']:>8} value={e['value']:<8} contribution={e['contribution']}")
        assert abs(e["value"] - round(float(x_row[e["feature"]]), 3)) < 1e-9, e


def test_dataframe_row():
    model, X = _toy()
    x = X.iloc[[7]]
    _check(lime_explanation(model, X, x), x.iloc[0])


def test_series_input():
    model, X = _toy()
    x = X.iloc[7]
    _check(lime_explanation(model, X, x), x)


def test_shuffled_column_order():
    model, X = _toy()
    x = X.iloc[[7]][list(reversed(X.columns))]
    _check(lime_explanation(model, X, x), x.iloc[0])


def test_numpy_input():
    model, X = _toy()
    _check(lime_explanation(model, X, X.iloc[7].values), X.iloc[7])


if __name__ == "__main__":
    for fn in (test_dataframe_row, test_series_input, test_shuffled_column_order, test_numpy_input):
        fn(); print("PASS", fn.__name__)
