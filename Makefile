setup:
	pip install -r requirements.txt

test:
	pytest -q

run:
	python -m src
