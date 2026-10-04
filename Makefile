# RhetorTrace: common tasks (run from the repository root, with the virtual environment active).

.PHONY: setup test eval dashboard server web web-test

setup:            ## Python and web dependencies
	pip install -r requirements.txt
	cd web && npm install

test:             ## Python test suite
	pytest -q

eval:             ## evaluation report from cached data (results/validation/EVALUATION.md)
	python scripts/evaluate.py

dashboard:        ## dashboard data and audio (web/public/) from the committed WAVs and cached alignments
	python -m src.features.pitch --all
	python -m src.features.energy --all
	python scripts/build_dashboard.py

server:           ## analysis job server on port 8000
	python -m src.server

web:              ## dashboard dev server on port 5173
	cd web && npm run dev

web-test:         ## web unit tests, type check and production build
	cd web && npm test && npm run build
