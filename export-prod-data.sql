.mode csv
.headers on
.output prod-readings-sample.csv
SELECT * FROM readings ORDER BY id DESC LIMIT 1000;
.output stdout
SELECT COUNT(*) as exported_rows FROM (SELECT * FROM readings ORDER BY id DESC LIMIT 1000);