import numpy as np, pandas as pd, joblib, os
from sklearn.ensemble import RandomForestClassifier

os.makedirs("models", exist_ok=True)
rng = np.random.default_rng(0)
N = 303
feature_names = [
    "Age","Sex","Weight","Length","BMI","DM","HTN","Current_Smoker","EX_Smoker","FH",
    "Obesity","DLP","CRF","CVA","Airway_disease","Thyroid_Disease","CHF",
    "BP","PR","Edema","Weak_Peripheral_Pulse","Lung_rales","Systolic_Murmur","Diastolic_Murmur",
    "Typical_Chest_Pain","Atypical","Nonanginal","Exertional_CP","LowTH_Ang","Dyspnea","Function_Class",
    "Q_Wave","St_Elevation","St_Depression","Tinversion","LVH","Poor_R_Progression","BBB",
    "FBS","CR","BUN","TG","LDL","HDL","ESR","HB","K","Na","WBC","Lymph","Neut","PLT",
    "EF_TTE","Region_RWMA","VHD",
]

X = pd.DataFrame(rng.normal(0.5, 1, (N, len(feature_names))), columns=feature_names)
y = rng.integers(0, 2, N)

for name in ["cad", "lad", "lcx", "rca"]:
    model = RandomForestClassifier(n_estimators=20, max_depth=4, random_state=0).fit(X, y)
    joblib.dump(model, f"models/{name}_pipeline.joblib")

df = X.copy()
df["Cath"] = y
df["LAD"] = y
df["LCX"] = y
df["RCA"] = y
df.to_csv("models/dataset.csv", index=False)
print("stub models + dataset written to models/")