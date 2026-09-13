import { useEffect, useState } from "react";
import { loadCategories, type CategoryOption } from "../api";

export function CategoryPicker({kind, value, onChange}: {
  kind: string; value: string[]; onChange: (value: string[]) => void;
}) {
  const [options, setOptions] = useState<CategoryOption[]>([]);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setOptions([]);
    setError(false);
    void loadCategories(kind, controller.signal).then((items) => {
      if (!controller.signal.aborted) setOptions(items);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [kind, retry]);
  const choices = [...options, ...value.filter((id) => !options.some((item) => item.id === id)).map((id) => ({id, name:id}))];
  return <fieldset className="category-picker">
    <legend>Категории проекта</legend>
    <p>Выберите подходящие темы - по ним игроки смогут найти проект. До 8 категорий.</p>
    <div className="category-choices">
      {choices.map((item) => <label key={item.id}>
        <input type="checkbox" checked={value.includes(item.id)} disabled={!value.includes(item.id) && value.length >= 8}
          onChange={(event) => onChange(event.target.checked ? [...value, item.id] : value.filter((id) => id !== item.id))} />
        {item.name}
      </label>)}
    </div>
    {error && <p>Категории недоступны. <button type="button" onClick={() => setRetry((n) => n + 1)}>Повторить</button></p>}
  </fieldset>;
}
