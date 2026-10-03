import itertools

import pytest

import helpers
import inbox


@pytest.fixture
def s3():
    return helpers.FakeS3()


@pytest.fixture
def ses():
    return helpers.FakeSES()


@pytest.fixture
def db():
    return helpers.FakeDB()


@pytest.fixture
def make_processor(s3, ses, db):
    def factory(**config_overrides):
        counter = itertools.count(1)
        return inbox.Processor(
            helpers.make_config(**config_overrides),
            s3,
            ses,
            db,
            now=lambda: helpers.FIXED_NOW,
            new_token=lambda: f"{next(counter):032x}",
        )

    return factory


@pytest.fixture
def processor(make_processor):
    return make_processor()
