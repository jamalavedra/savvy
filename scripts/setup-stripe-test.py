#!/usr/bin/env python3
"""Create/reuse only test Prices; keep credentials and selectors outside the repo."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ENV = Path.home() / ".config/savvy/stripe-test.env"
values = dict(line.split("=", 1) for line in ENV.read_text().splitlines() if "=" in line)
secret = values["SAVVY_STRIPE_SECRET_KEY"]
if not secret.startswith("sk_test_"):
    raise SystemExit("Only a Stripe test secret is accepted")


def stripe(path, form=None, key=None):
    request = urllib.request.Request(
        "https://api.stripe.com/v1/" + path,
        data=urllib.parse.urlencode(form).encode() if form is not None else None,
        headers={"Authorization": "Bearer " + secret, "Stripe-Version": "2025-06-30.basil"}
        | ({"Idempotency-Key": key} if key else {}),
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            value = json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Stripe rejected setup with HTTP {error.code}; credentials omitted") from None
    if value.get("livemode") is True:
        raise SystemExit("Refusing a live-mode object")
    return value


for product, offer in json.loads((ROOT / "config/managed-catalog.json").read_text()).items():
    lookup = "savvy_" + offer["version"]
    prices = stripe("prices?" + urllib.parse.urlencode({"lookup_keys[]": lookup, "limit": 100}))
    if prices["data"]:
        price = prices["data"][0]
    else:
        form = {
            "currency": offer["currency"], "unit_amount": offer["amountCents"],
            "product_data[name]": "Savvy managed " + product,
            "lookup_key": lookup, "metadata[savvy_catalog_version]": offer["version"],
        }
        if offer["interval"]:
            form["recurring[interval]"] = offer["interval"]
        price = stripe("prices", form, lookup)
    assert price["active"] and price["currency"] == offer["currency"]
    assert price["unit_amount"] == offer["amountCents"]
    assert price["billing_scheme"] == "per_unit" and price.get("transform_quantity") is None
    if offer["interval"]:
        assert price["recurring"]["interval_count"] == 1
        assert price["recurring"]["usage_type"] == "licensed"
    assert price["metadata"]["savvy_catalog_version"] == offer["version"]
    assert (price.get("recurring") or {}).get("interval") == offer["interval"]
    values["SAVVY_STRIPE_PRICE_" + product.upper()] = price["id"]
    print(product + ": " + price["id"] + " verified in test mode")

fd = os.open(ENV, os.O_WRONLY | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as output:
    output.write("".join(f"{name}={value}\n" for name, value in values.items()))
print("Private selectors saved. No live payment, website, webhook endpoint or release published.")
